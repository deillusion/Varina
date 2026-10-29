import { EventEmitter } from 'node:events';
import { NodeWorkspaceHost, defaultWorkspaceRoot, defaultSessionDataDir } from '../host/node_workspace_host.mjs';
import { loadNodeAgentConfig } from '../host/node_agent_config.mjs';
import { NodeFsHost } from '../host/node_fs_host.mjs';
import { AgentSession, createSessionState } from './agent_session.mjs';
import { AgentSessionStore } from './session_store.mjs';
import { ModelGateway } from './model_gateway.mjs';
import { createJevDecisionGateway } from '../decision/jev_gateway.mjs';
import { createOperatorPool } from '../varina/operator_pool.mjs';

function validateModelReferences(config) {
  if (!Array.isArray(config?.models) || !config.models.length) throw new Error('注入的模型列表不能为空');
  const ids = new Set();
  for (const model of config.models) {
    if (typeof model?.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new Error('注入的模型 ID 必须非空且唯一');
    ids.add(model.id);
  }
  if (!ids.has(config.roles?.main)) throw new Error('main 必须引用注入列表中的模型');
  for (const [role, modelId] of Object.entries(config.roles)) {
    if (modelId != null && !ids.has(modelId)) throw new Error(`角色 ${role} 引用了未注入的模型：${modelId}`);
  }
  if (!Array.isArray(config.seats)) throw new Error('注入的 seats 必须是数组');
  for (const seat of config.seats) {
    if (!ids.has(seat?.modelId)) throw new Error(`席位 ${seat?.id} 引用了未注入的模型：${seat?.modelId}`);
  }
}

export class AgentTurnConflictError extends Error {
  constructor(message = '这个会话已有一轮正在处理') {
    super(message);
    this.name = 'AgentTurnConflictError';
    this.code = 'AGENT_TURN_ACTIVE';
  }
}

export class AgentService {
  constructor({
    root,
    dataDir,
    workspaceRoot,
    workspaceHost = new NodeWorkspaceHost(workspaceRoot ?? defaultWorkspaceRoot(root)),
    env = {},
    operatorPool,
    store = new AgentSessionStore(dataDir ?? defaultSessionDataDir(root)),
    configLoader = loadNodeAgentConfig,
    hostFactory = workspace => new NodeFsHost(workspace),
    gatewayFactory = (config, options) => new ModelGateway(config, options),
    decisionGatewayFactory = createJevDecisionGateway
  } = {}) {
    this.root = root;
    this.workspaceHost = workspaceHost;
    this.workspaceRoot = workspaceHost.root;
    this.env = env;
    this.operatorPool = operatorPool === undefined ? undefined : createOperatorPool(operatorPool);
    this.store = store;
    this.configLoader = configLoader;
    this.hostFactory = hostFactory;
    this.gatewayFactory = gatewayFactory;
    this.decisionGatewayFactory = decisionGatewayFactory;
    this.active = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(128);
    this.initialized = false;
    this.workspaceRealRoot = null;
  }

  async init() {
    if (this.initialized) return this;
    await this.workspaceHost.init();
    this.workspaceRealRoot = this.workspaceHost.realRoot ?? this.workspaceHost.root;
    await this.store.init();
    const interruptedStatuses = new Set(['running', 'baseline_complete', 'evaluating_varina', 'running_varina']);
    for (const session of await this.store.list()) {
      if (interruptedStatuses.has(session.status)) {
        session.status = 'interrupted';
        delete session.active_turn;
        const activeRuntime = session.active_varina_runtime ?? session.active_aha_runtime;
        if (activeRuntime) {
          const runs = session.varina_runs ?? session.aha_runs ?? [];
          const run = runs.find(item => item.run_id === activeRuntime.run_id);
          if (run?.state === 'active') {
            run.state = 'interrupted';
            run.stop_reason = 'process_interrupted';
          }
        }
        await this.store.save(session);
      }
    }
    this.initialized = true;
    return this;
  }

  async resolveWorkspace(requested) {
    return this.workspaceHost.resolve(requested);
  }

  async browseDirectories(requested = null) {
    await this.init();
    return this.workspaceHost.browse(requested);
  }

  async create({ workspace_root, title, mode = 'live' } = {}) {
    await this.init();
    if (!['live', 'mock'].includes(mode)) throw new Error('mode 必须是 live 或 mock');
    const state = createSessionState(await this.resolveWorkspace(workspace_root), { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : '新会话' });
    state.mode = mode;
    await this.store.save(state);
    return state;
  }

  async get(sessionId) { await this.init(); return this.store.get(sessionId); }

  async list(mode) {
    await this.init();
    return (await this.store.list(mode)).map(session => this.summary(session));
  }

  async delete(sessionId) {
    await this.init();
    const slot = this.active.get(sessionId);
    if (slot) {
      slot.controller.abort('session_deleted');
      this.active.delete(sessionId);
    }
    const ok = await this.store.delete(sessionId);
    return { ok, session_id: sessionId };
  }

  async clearMock() {
    await this.init();
    for (const [id, slot] of this.active.entries()) {
      try {
        const s = await this.store.get(id);
        if (s.mode === 'mock') {
          slot.controller.abort('session_deleted');
          this.active.delete(id);
        }
      } catch {}
    }
    const count = await this.store.deleteMany({ mode: 'mock' });
    return { ok: true, count };
  }

  summary(session) {
    return {
      session_id: session.session_id,
      title: session.title,
      status: session.status,
      mode: session.mode,
      workspace_root: session.workspace_root || null,
      current_turn: session.current_turn,
      varina_runs: (session.varina_runs ?? session.aha_runs)?.length ?? 0,
      aha_runs: (session.varina_runs ?? session.aha_runs)?.length ?? 0,
      created_at: session.created_at,
      updated_at: session.updated_at,
      last_message: session.messages?.at(-1)?.content?.slice(0, 160) ?? ''
    };
  }

  subscribe(sessionId, listener) {
    this.events.on(sessionId, listener);
    return () => this.events.off(sessionId, listener);
  }

  async #createAgentSession(state, { signal, onEvent, maxToolIterations }) {
    const config = await this.configLoader(this.root, state.mode ?? 'live');
    validateModelReferences(config);
    const host = await this.hostFactory(state.workspace_root).init();
    const gatewayOptions = {
      mode: state.mode ?? 'live', signal,
      onCall: call => {
        state.calls.push(call);
        onEvent({ event: 'model_call', session_id: state.session_id, phase: call.phase, status: call.status, model_id: call.model_id });
      }
    };
    const gateway = this.gatewayFactory(config, gatewayOptions);
    const decisionGateway = this.decisionGatewayFactory(config, gatewayOptions);
    const resolvedMaxIterations = Number(maxToolIterations)
      || Number(this.env.VARINA_MAX_TOOL_ITERATIONS)
      || Number(this.env.AHA_MAX_TOOL_ITERATIONS)
      || config?.max_tool_iterations
      || config?.agent?.max_tool_iterations
      || 100;
    return new AgentSession({
      state, host, store: this.store, gateway, decisionGateway, config, operatorPool: this.operatorPool,
      signal, onEvent, env: this.env, maxToolIterations: resolvedMaxIterations
    });
  }

  async startTurn(sessionId, message, { enable_varina, enable_aha, max_tool_iterations } = {}) {
    await this.init();
    if (this.active.has(sessionId)) throw new AgentTurnConflictError();
    const state = await this.store.get(sessionId);
    const controller = new AbortController();
    const slot = { controller, completion: null };
    this.active.set(sessionId, slot);
    const publish = event => this.events.emit(sessionId, event);
    slot.completion = (async () => {
      const agent = await this.#createAgentSession(state, {
        signal: controller.signal, onEvent: publish, maxToolIterations: max_tool_iterations
      });
      const enabled = enable_varina ?? enable_aha;
      return agent.turn(message, { enable_varina: enabled, enable_aha: enabled });
    })().catch(async error => {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      delete state.active_turn;
      const assistant = {
        id: `msg-service-${Date.now()}`,
        role: 'assistant',
        content: controller.signal.aborted ? '本轮已取消。' : `本轮无法启动：${String(error?.message ?? error).slice(0, 500)}`,
        created_at: new Date().toISOString(),
        partial: true
      };
      state.messages.push(assistant);
      await this.store.save(state).catch(() => {});
      publish({ event: 'agent_done', session_id: sessionId, message: assistant });
      return assistant;
    }).finally(() => {
      if (this.active.get(sessionId) === slot) this.active.delete(sessionId);
    });
    return { session_id: sessionId, completion: slot.completion };
  }

  async turn(sessionId, message, options = {}) {
    const started = await this.startTurn(sessionId, message, options);
    return started.completion;
  }

  async startVarinaConfirmation(sessionId, confirmationId, accepted) {
    await this.init();
    if (this.active.has(sessionId)) throw new AgentTurnConflictError();
    const state = await this.store.get(sessionId);
    const controller = new AbortController();
    const slot = { controller, completion: null };
    this.active.set(sessionId, slot);
    const publish = event => this.events.emit(sessionId, event);
    slot.completion = (async () => {
      if (!accepted) {
        const agent = new AgentSession({ state, store: this.store, env: this.env, onEvent: publish });
        return agent.resolveVarinaConfirmation(confirmationId, false);
      }
      const agent = await this.#createAgentSession(state, {
        signal: controller.signal, onEvent: publish
      });
      return agent.resolveVarinaConfirmation(confirmationId, accepted);
    })().catch(async error => {
      state.status = 'idle';
      const assistant = {
        id: `msg-varina-confirm-${Date.now()}`,
        role: 'assistant',
        content: `常规回答已保留，但 Varina 后续探索未能完成：${String(error?.message ?? error).slice(0, 500)}`,
        created_at: new Date().toISOString(),
        partial: true,
        message_kind: 'varina_addendum'
      };
      state.messages.push(assistant);
      await this.store.save(state).catch(() => {});
      publish({ event: 'agent_done', session_id: sessionId, message: assistant });
      return assistant;
    }).finally(() => {
      if (this.active.get(sessionId) === slot) this.active.delete(sessionId);
    });
    return { session_id: sessionId, completion: slot.completion };
  }

  cancel(sessionId) {
    const slot = this.active.get(sessionId);
    if (!slot) throw new AgentTurnConflictError('这个会话当前没有正在处理的轮次');
    slot.controller.abort('user_cancelled');
    return { status: 'stopping' };
  }

  async stop() {
    for (const slot of this.active.values()) slot.controller.abort('server_stopping');
    await Promise.allSettled([...this.active.values()].map(slot => slot.completion));
  }
}
