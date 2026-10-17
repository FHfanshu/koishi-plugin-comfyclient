import FormData from 'form-data';
import WebSocket, { RawData } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'koishi';

const PROMPT_PLACEHOLDER = '{{prompt}}';
type PlaceholderDict = Record<string, string | number | boolean>;

const escapeRegExp = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ComfyUINode {
  serverEndpoint: any;
  isSecureConnection: boolean;
  clientId: any;
  ws: any;
  ctx: any;
  logger?: Logger;
  logEnabled: boolean;
  debugEnabled: boolean;
  httpProxy?: string;
  accessPassword?: string;
  insecureTLS?: boolean;
  private envProxySnapshot: Record<string, string | undefined>;

  constructor(
    ctx: any,
    serverEndpoint: any,
    isSecureConnection: boolean = false,
    logger?: Logger,
    logEnabled: boolean = true,
    debugEnabled: boolean = false,
    clientId: any = null,
    httpProxy?: string,
    accessPassword?: string,
    insecureTLS: boolean = false
  ) {
    this.ctx = ctx;
    this.serverEndpoint = serverEndpoint;
    this.isSecureConnection = isSecureConnection;
    this.clientId = clientId || uuidv4();
    this.ws = null;
    this.logger = logger;
    this.logEnabled = logEnabled;
    this.debugEnabled = debugEnabled;
    this.accessPassword = accessPassword;
    this.insecureTLS = insecureTLS;
    this.httpProxy = httpProxy;
    this.envProxySnapshot = this.captureEnvProxy();
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private captureEnvProxy() {
    // 记录启动时的代理环境变量，便于日志观察
    return {
      http_proxy: process.env.http_proxy || process.env.HTTP_PROXY,
      https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY,
      all_proxy: process.env.all_proxy || process.env.ALL_PROXY,
      no_proxy: process.env.no_proxy || process.env.NO_PROXY,
    };
  }

  private parseProxy(urlStr?: string) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr);
      if (!u.port) return null;
      return {
        protocol: u.protocol?.replace(':', ''),
        host: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        auth: u.username ? { username: u.username, password: u.password || '' } : undefined,
      };
    } catch {
      return null;
    }
  }

  private isRetryableError(error: any) {
    const status = error?.response?.status;
    const code = error?.code || error?.cause?.code;
    const message: string = error?.message || '';

    const retryableStatus = [408, 425, 429, 500, 502, 503, 504];
    const retryableCodes = ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT'];

    if (status && retryableStatus.includes(status)) return true;
    if (code && retryableCodes.includes(code)) return true;
    if (/timeout/i.test(message) || /network/i.test(message) || /fetch failed/i.test(message)) return true;
    return false;
  }

  private async withRetry<T>(action: string, fn: () => Promise<T>, maxAttempts = 3, baseDelay = 400): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          this.log('warn', `${action}失败，正在重试`, { attempt, maxAttempts });
        }
        return await fn();
      } catch (error) {
        lastError = error;
        const canRetry = this.isRetryableError(error) && attempt < maxAttempts;
        this.log(canRetry ? 'warn' : 'error', `${action}出错`, {
          attempt,
          maxAttempts,
          error: error?.message || error
        });
        if (!canRetry) break;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, any>) {
    if (!this.logEnabled) return;
    const safeMeta = meta ? JSON.stringify(meta) : '';
    const text = safeMeta ? `${message} ${safeMeta}` : message;

    // 1) 调用 Koishi logger（可能被等级过滤）
    if (this.logger) {
      if (level !== 'debug' || this.debugEnabled) {
        (this.logger as any)[level]?.(text);
      }
      // debug 开启时，用 info 再打印一份保证可见
      if (level === 'debug' && this.debugEnabled) {
        (this.logger as any)['info']?.(`[debug] ${text}`);
      }
    }

    // 2) 直接输出 stdout，绕过 Koishi 等级过滤（仅 debug 时启用）
    if (level === 'debug' && this.debugEnabled) {
      const prefix = '[comfyui-client][debug]';
      console.log(`${prefix} ${text}`);
    }
  }

  /**
   * 用户上传图片，返回服务器的响应值
   * @param {Buffer|ArrayBuffer} imageBuffer - 图片数据
   * @param {string} filename - 文件名（需要包含扩展名，否则 ComfyUI 可能报错）
   * @param {boolean} overwrite - 是否覆盖已存在的文件，默认true
   * @param {object} options - 额外上传配置
   * @param {number} options.timeoutMs - 单次请求超时时间，默认120000ms
   * @param {number} options.maxAttempts - 最大重试次数，默认3
   * @returns {Promise<Object>} 服务器响应，包含success、data和message
   */
  async uploadImage(
    imageBuffer,
    filename,
    overwrite = true,
    options: { timeoutMs?: number; maxAttempts?: number } = {}
  ) {
    const { timeoutMs = 120000, maxAttempts = 3 } = options;
    try {
      await this.ensureAccessAuth();
      const buildForm = () => {
        const formData = new FormData();
        formData.append('image', imageBuffer, filename);
        formData.append('overwrite', overwrite.toString());
        return formData;
      };

      const resolveProxy = () => {
        // 1) 配置优先
        const fromConfig = this.parseProxy(this.httpProxy?.trim());
        if (fromConfig) return { proxy: fromConfig, source: 'config' };

        // 2) 环境变量兜底（优先 http_proxy/https_proxy，其次 all_proxy）
        const envCandidate = this.envProxySnapshot.http_proxy || this.envProxySnapshot.https_proxy || this.envProxySnapshot.all_proxy;
        const fromEnv = this.parseProxy(envCandidate);
        if (fromEnv) return { proxy: fromEnv, source: 'env' };

        return { proxy: undefined, source: 'direct' }; // 无代理
      };

      const sendOnce = async (attempt: number) => {
        const formData = buildForm();

        const getContentLength = () =>
          new Promise<number | undefined>((resolve) => {
            formData.getLength((err, length) => {
              if (err) {
                this.log('warn', '计算 Content-Length 失败，改用 chunked 传输', { attempt, error: err?.message || err });
                resolve(undefined);
              } else {
                resolve(length);
              }
            });
          });

        const contentLength = await getContentLength();

        const { proxy, source: proxySource } = resolveProxy();
        this.log('debug', '开始上传图片到 ComfyUI', {
          attempt,
          filename,
          contentLength,
          proxy: proxy ? `${proxy.host}:${proxy.port || ''}` : proxySource,
          envProxy: proxySource !== 'config' ? this.envProxySnapshot : undefined,
        });

        const url = `${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/upload/image`;
        const started = Date.now();
        const response = await this.ctx.http.post(url, formData as any, {
          headers: {
            ...formData.getHeaders(),
            ...(typeof contentLength === 'number' ? { 'Content-Length': contentLength } : {}),
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: timeoutMs,
          proxy,
        });

        const costMs = Date.now() - started;
        const respAny: any = response;
        this.log('debug', '上传图片 HTTP 返回', {
          attempt,
          status: respAny?.status ?? 'n/a',
          elapsedMs: costMs,
          contentType: respAny?.headers?.['content-type'],
          payloadKeys: respAny?.data ? Object.keys(respAny.data).slice(0, 5) : [],
        });

        return response;
      };

      let attemptCounter = 0;
      const response = await this.withRetry('上传图片到 ComfyUI', () => {
        attemptCounter += 1;
        return sendOnce(attemptCounter);
      }, maxAttempts);

      const payload = (response as any)?.data ?? response;
      this.log('info', '上传图片到 ComfyUI 成功', { filename, overwrite, payload });
      return {
        success: true,
        data: payload,
        message: 'Image uploaded successfully'
      };
    } catch (error) {
      const status = (error as any)?.response?.status;
      const body = (error as any)?.response?.data;
      const detail = body || (error as any)?.message || error;
      const bodyPreview = typeof body === 'string' ? body.slice(0, 500) : undefined;
      this.log('error', '上传图片到 ComfyUI 失败', { filename, status, error: detail, bodyPreview });
      return {
        success: false,
        error: detail,
        message: 'Failed to upload image'
      };
    }
  }

  /**
   * 建立WebSocket连接
   * @returns {Promise<void>}
   */
  /**
   * SakuraFrp 等 frp 服务的「访问密码」是按来源 IP 放行一段时间的表单认证：
   * GET 会返回登录页（HTML），把页面里的 csrf / ip 连同密码 POST 回去即可放行。
   * 已放行时 GET 直接返回 JSON，这里就什么也不做。
   */
  private async ensureAccessAuth() {
    if (!this.accessPassword) return;
    const base = `${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}`;
    const doFetch = (globalThis as any).fetch;
    if (typeof doFetch !== 'function') return;

    try {
      const probe = await doFetch(`${base}/system_stats`, { redirect: 'manual' });
      const text = await probe.text();
      if (text.trimStart().startsWith('{')) return;

      const csrf = /name="csrf" value="([^"]*)"/.exec(text)?.[1] || '';
      const ip = /name="ip" value="([^"]*)"/.exec(text)?.[1] || '';
      const body = new URLSearchParams({ pw: this.accessPassword, persist_auth: 'on', csrf, ip });
      const res = await doFetch(`${base}/system_stats`, { method: 'POST', body, redirect: 'manual' });
      this.log('info', '已提交 frp 访问密码', { status: res.status, csrf, ip });

      const after = await doFetch(`${base}/system_stats`, { redirect: 'manual' });
      const afterText = await after.text();
      if (!afterText.trimStart().startsWith('{')) {
        this.log('warn', '访问密码未放行，仍返回非 JSON', { status: after.status });
      }
    } catch (error) {
      this.log('warn', '提交 frp 访问密码失败', { error: (error as any)?.message || error });
    }
  }

  async connect(maxAttempts = 3) {
    const url = `${this.isSecureConnection ? 'wss' : 'ws'}://${this.serverEndpoint}/ws?clientId=${this.clientId}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          this.ws = new WebSocket(url, { perMessageDeflate: false, rejectUnauthorized: !this.insecureTLS });

          const handleError = (err) => {
            this.log('error', 'WebSocket 连接错误', { attempt, error: err.message });
            this.ws?.terminate?.();
            cleanup();
            reject(err);
          };

          const handleOpen = () => {
            this.log('info', 'WebSocket 连接已建立', { url, attempt });
            cleanup();
            resolve();
          };

          const handleClose = () => {
            this.log('warn', 'WebSocket 连接已关闭');
            this.ws = null;
          };

          const handleMessage = (data, isBinary) => {
            if (!isBinary) {
              try {
                const message = JSON.parse(data.toString());
                this._handleWebSocketMessage(message);
              } catch (err) {
                this.log('warn', '解析 WebSocket 消息失败', { error: err.message });
              }
            }
          };

          const cleanup = () => {
            this.ws?.off('open', handleOpen);
            this.ws?.off('error', handleError);
            this.ws?.off('close', handleClose);
            this.ws?.off('message', handleMessage);
          };

          this.ws.on('open', handleOpen);
          this.ws.on('error', handleError);
          this.ws.on('close', handleClose);
          this.ws.on('message', handleMessage);
        });

        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        const backoff = 300 * Math.pow(2, attempt - 1);
        await this.sleep(backoff);
      }
    }
  }

  /**
   * 处理WebSocket消息
   * @param {Object} message - WebSocket消息
   */
  _handleWebSocketMessage(message) {
    switch (message.type) {
      case 'status':
        break;
      case 'progress':
        if (message.data.max && message.data.value !== undefined) {
          const progress = ((message.data.value / message.data.max) * 100).toFixed(1);
          process.stdout.write(`\rProgress: ${progress}% `);
        }
        break;
      case 'executing':
        if (message.data.node) {
          this.log('debug', '工作流节点执行中', { node: message.data.node, promptId: message.data.prompt_id });
        }
        break;
      case 'execution_start':
        this.log('info', '工作流开始执行', { promptId: message.data?.prompt_id });
        break;
      case 'executed':
        this.log('info', '工作流节点执行完成', { node: message.data?.node });
        break;
      default:
        break;
    }
  }

  /**
   * 断开WebSocket连接
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.ws) {
      this.log('info', '主动断开 WebSocket 连接');
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 提交prompt到队列
   * @param {Object} prompt - JSON格式的prompt
   * @returns {Promise<Object>} 队列响应
   */
  async queuePrompt(prompt) {
    try {
      const response = await this.withRetry<any>('提交工作流到队列', () => this.ctx.http.post(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/prompt`, {
        prompt,
        client_id: this.clientId
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        proxy: undefined, // 避免因手动代理配置影响提示提交；遵循环境变量
      }));
      this.log('info', '提交工作流到队列成功', { promptId: response.prompt_id, number: response.number });
      return {
        success: true,
        data: response,
        prompt_id: response.prompt_id,
        number: response.number
      };
    } catch (error) {
      this.log('error', '提交工作流到队列失败', { error: error.response?.data || error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to queue prompt'
      };
    }
  }

  /**
   * 获取执行历史
   * @param {string} promptId - prompt ID
   * @returns {Promise<Object>} 历史记录
   */
  async getHistory(promptId) {
    try {
      const url = promptId ?
        `${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/history/${promptId}` :
        `${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/history`; 

      const response = await this.withRetry<any>('获取历史记录', () => this.ctx.http.get(url));

      this.log('debug', '获取历史记录', { promptId });
      return {
        success: true,
        data: promptId ? response[promptId] : response
      };
    } catch (error) {
      this.log('error', '获取历史记录失败', { promptId, error: error.response?.data || error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to get history'
      };
    }
  }

  /**
   * 获取生成的图片
   * @param {string} filename - 文件名
   * @param {string} subfolder - 子文件夹
   * @param {string} type - 类型
   * @returns {Promise<Buffer>} 图片数据
   */
  async getImage(filename, subfolder = '', type = 'output') {
    try {
      const url = `${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
      const response = await this.withRetry<ArrayBuffer>('获取生成图片', () => this.ctx.http.get(url, { responseType: 'arraybuffer' }));

      this.log('info', '获取生成图片成功', { filename, subfolder, type });
      const imageBuffer = Buffer.from(response as ArrayBuffer);
      return {
        success: true,
        data: response,
        buffer: imageBuffer
      };
    } catch (error) {
      this.log('error', '获取生成图片失败', { filename, subfolder, error: error.response?.data || error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to get image'
      };
    }
  }

  /**
   * 等待prompt执行完成并获取结果
   * @param {string} promptId - prompt ID
   * @returns {Promise<Object>} 执行结果
   */
  async waitForCompletion(promptId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        this.ws?.off('message', onMessage);
        reject(new Error('Execution timeout'));
      }, 300000); // 5分钟超时

      const onClose = () => {
        clearTimeout(timeout);
        this.ws?.off('message', onMessage);
        this.ws?.off('close', onClose);
        reject(new Error('WebSocket closed before completion'));
      };

      const onMessage = async (data: RawData, isBinary: boolean) => {
        if (isBinary) return;

        try {
          const textPayload = (() => {
            if (typeof data === 'string') return data;
            if (Array.isArray(data)) return Buffer.concat(data).toString();
            return Buffer.from(data as ArrayBuffer).toString();
          })();

          const message = JSON.parse(textPayload);
          const messageData = message.data;

          // 检查是否是我们等待的prompt完成消息
            if (message.type === 'executing' &&
              messageData.prompt_id === promptId &&
              messageData.node === null) {

            clearTimeout(timeout);
            this.ws?.off('message', onMessage);
            this.ws?.off('close', onClose);

            // 获取执行历史和结果（容错重试，避免写盘延迟导致 outputs 为空）
            const fetchHistoryWithRetry = async () => {
              const attempts = 10;
              const delay = 500;
              let last: any;
              for (let i = 1; i <= attempts; i++) {
                last = await this.getHistory(promptId);
                const hasOutputs = last?.success && last.data && Object.keys(last.data.outputs || {}).length > 0;
                if (hasOutputs) {
                  this.log('info', '获取执行历史成功', { attempt: i, promptId });
                  return last;
                }
                this.log('debug', '执行历史尚无输出，等待重试', { attempt: i, promptId });
                if (i < attempts) await this.sleep(delay);
              }
              return last;
            };

            const historyResult = await fetchHistoryWithRetry();
            if (!historyResult?.success) {
              reject(new Error('Failed to get execution history'));
              return;
            }

            const history = historyResult.data || {};
            const outputs = {};

            // 处理输出结果
            for (const nodeId of Object.keys(history.outputs || {})) {
              const nodeOutput = history.outputs[nodeId];
              if (nodeOutput.images) {
                const images = [];
                for (const imageInfo of nodeOutput.images) {
                  const type = imageInfo.type || 'output';
                  const imageResult = await this.getImage(
                    imageInfo.filename,
                    imageInfo.subfolder,
                    type
                  );

                  if (imageResult.success) {
                    images.push({
                      filename: imageInfo.filename,
                      subfolder: imageInfo.subfolder,
                      type,
                      buffer: imageResult.buffer,
                      data: imageResult.data
                    });
                  }
                }
                outputs[nodeId] = { images };
              }
            }

            const status = (history as any)?.status;
            const historyError = (history as any)?.error
              || status?.error
              || status?.detail
              || status?.message;
            const nodeErrors = Object.values<any>(history.outputs || {}).flatMap((n: any) => n?.errors || []);
            const combinedError = historyError || (nodeErrors.length ? nodeErrors.join('\n') : undefined);
            const success = !combinedError;

            if (!success) {
              this.log('error', '工作流执行失败', { promptId, error: combinedError });
            } else {
              this.log('info', '工作流执行完成', { promptId });
            }

            resolve({
              success,
              prompt_id: promptId,
              outputs,
              history,
              error: combinedError,
              message: success ? 'Execution completed successfully' : combinedError
            });
          }
        } catch (err) {
          clearTimeout(timeout);
          this.ws?.off('message', onMessage);
          this.ws?.off('close', onClose);
          reject(err);
        }
      };

      this.ws.on('message', onMessage);
      this.ws.on('close', onClose);
    });
  }

  /**
   * 避免缓存：修改prompt中的随机参数
   * @param {Object} promptJson - 原始prompt
   * @param {boolean} avoidCache - 是否避免缓存，默认true
   * @returns {Object} 修改后的prompt
   */
  _modifyPromptToAvoidCache(promptJson, avoidCache = true) {
    if (!avoidCache) {
      return promptJson;
    }

    // 深拷贝prompt以避免修改原始对象
    const modifiedPrompt = JSON.parse(JSON.stringify(promptJson));

    // 生成随机seed
    const randomSeed = Math.floor(Math.random() * 1000000000000000);

    // 查找并修改所有包含seed的节点
    for (const nodeId in modifiedPrompt) {
      const node = modifiedPrompt[nodeId];
      if (node.inputs && typeof node.inputs.seed !== 'undefined') {
        node.inputs.seed = randomSeed;
      }

      // 对于一些特殊的随机参数也进行修改
      if (node.inputs && typeof node.inputs.noise_seed !== 'undefined') {
        node.inputs.noise_seed = randomSeed;
      }
    }

    return modifiedPrompt;
  }

  private _injectPlaceholders(promptJson: any, replacements: PlaceholderDict) {
    const placeholderKeys = Object.keys(replacements || {});
    const placeholderRegexes = placeholderKeys.map(key => ({
      key,
      pattern: new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'gi'),
    }));

    const used = new Set<string>();
    const promptProvided = typeof replacements?.prompt !== 'undefined' && String(replacements.prompt).length > 0;

    const replace = (value: any): any => {
      if (typeof value === 'string') {
        let result = value;
        for (const { key, pattern } of placeholderRegexes) {
          if (pattern.test(result)) {
            used.add(key);
            const replacement = String(replacements[key] ?? '');
            result = result.replace(pattern, replacement);
          }
        }
        return result;
      }

      if (Array.isArray(value)) {
        return value.map(item => replace(item));
      }

      if (value && typeof value === 'object') {
        const cloned: Record<string, any> = {};
        for (const key of Object.keys(value)) {
          cloned[key] = replace(value[key]);
        }
        return cloned;
      }

      return value;
    };

    const replaced = replace(promptJson);

    // 针对 prompt 占位符保持原有提醒（仅当用户确实提供了提示词）
    if (promptProvided && !used.has('prompt')) {
      this.log('warn', '工作流中未找到提示词占位符，将使用原始JSON', { placeholder: PROMPT_PLACEHOLDER });
    }

    const unused = placeholderKeys.filter(k => !used.has(k));
    if (unused.length) {
      this.log('debug', '部分占位符未在工作流中使用', { unused });
    }

    return replaced;
  }

  /**
   * 用户上传JSON格式的prompt文本，执行该prompt工作流
   * 执行后轮询，直到成功后返回服务器的响应值
   * @param {Object} workflowJson - JSON格式的prompt
   * @param {string} userPrompt - 用户输入的prompt
   * @param {Object} options - 执行选项
   * @param {boolean} options.avoidCache - 是否避免缓存，默认true
   * @param {PlaceholderDict} options.placeholders - 其他占位符替换
   * @returns {Promise<Object>} 执行结果
   */
  async executePromptWorkflow(workflowJson: any, userPrompt: string, options: any = {}) {
    const { avoidCache = true, placeholders = {} as PlaceholderDict } = options;

    try {

      // 0) 若目标在 frp 访问密码后面，先换放行
      await this.ensureAccessAuth();

      // 0.1) 修改prompt
      const newSeedPrompt = this._modifyPromptToAvoidCache(workflowJson, avoidCache);
      const finalPrompt = this._injectPlaceholders(newSeedPrompt, { prompt: userPrompt, ...placeholders });
      // 0.5 轻量健康检查，避免长时间空闲后连接假死
      try {
        const health = await this.getQueueStatus();
        if (!health.success) {
          this.log('warn', '健康检查失败，可能无法提交工作流', { error: health.error });
        }
      } catch (healthError) {
        this.log('warn', '健康检查异常，继续尝试执行', { error: healthError?.message || healthError });
      }
      // 1. 建立WebSocket连接
      this.log('debug', '准备建立 WebSocket 连接', { endpoint: this.serverEndpoint, secure: this.isSecureConnection });
      await this.connect();
      this.log('debug', 'WebSocket 连接已就绪', { clientId: this.clientId });
      // 2. 提交prompt到队列
      this.log('debug', '提交工作流到队列', { hasPrompt: !!userPrompt, placeholderKeys: Object.keys(placeholders || {}) });
      const queueResult = await this.queuePrompt(finalPrompt);
      if (!queueResult.success) {
        this.log('error', '提交工作流到队列失败', { error: queueResult.error || queueResult.message });
        await this.disconnect();
        return queueResult;
      }

      this.log('info', '等待工作流执行', { promptId: queueResult.prompt_id });
      // 3. 等待执行完成
      const executionResult = await this.waitForCompletion(queueResult.prompt_id);

      // 4. 断开连接
      this.log('debug', '准备断开 WebSocket 连接', { clientId: this.clientId });
      await this.disconnect();

      return executionResult;

    } catch (error) {
      // 确保断开连接
      await this.disconnect();

      this.log('error', '执行工作流失败', { error: error.message });
      return {
        success: false,
        error: error.message,
        message: 'Workflow execution failed'
      };
    }
  }

  /**
   * 中断当前执行
   * @returns {Promise<Object>} 中断结果
   */
  async interrupt() {
    try {
      const response = await this.withRetry<any>('中断执行', () => this.ctx.http.post(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/interrupt`, null, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }));

      this.log('warn', '中断执行成功');
      return {
        success: true,
        data: response,
        message: 'Execution interrupted successfully'
      };
    } catch (error) {
      this.log('error', '中断执行失败', { error: error.response?.data || error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to interrupt execution'
      };
    }
  }

  /**
   * 获取队列状态
   * @returns {Promise<Object>} 队列状态
   */
  async getQueueStatus() {
    try {
      const response = await this.withRetry<any>('获取队列状态', () => this.ctx.http.get(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/queue`));

      this.log('debug', '获取队列状态成功');
      return {
        success: true,
        data: response,
        message: 'Queue status retrieved successfully'
      };
    } catch (error) {
      this.log('error', '获取队列状态失败', { error: error.response?.data || error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to get queue status'
      };
    }
  }
}

export default ComfyUINode;
