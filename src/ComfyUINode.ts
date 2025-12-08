import FormData from 'form-data';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'koishi';

const PROMPT_PLACEHOLDER = '{{prompt}}';

export class ComfyUINode {
  serverEndpoint: any;
  isSecureConnection: boolean;
  clientId: any;
  ws: any;
  ctx: any;
  logger?: Logger;
  logEnabled: boolean;

  constructor(ctx: any, serverEndpoint: any, isSecureConnection: boolean = false, logger?: Logger, logEnabled: boolean = true, clientId: any = null) {
    this.ctx = ctx;
    this.serverEndpoint = serverEndpoint;
    this.isSecureConnection = isSecureConnection;
    this.clientId = clientId || uuidv4();
    this.ws = null;
    this.logger = logger;
    this.logEnabled = logEnabled;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, any>) {
    if (!this.logEnabled || !this.logger) return;
    const safeMeta = meta ? JSON.stringify(meta) : '';
    // Koishi logger methods mirror standard console levels
    (this.logger as any)[level]?.(safeMeta ? `${message} ${safeMeta}` : message);
  }

  /**
   * 用户上传图片，返回服务器的响应值
   * @param {Buffer|ArrayBuffer} imageBuffer - 图片数据
   * @param {string} filename - 文件名
   * @param {boolean} overwrite - 是否覆盖已存在的文件，默认true
   * @returns {Promise<Object>} 服务器响应，包含success、data和message
   */
  async uploadImage(imageBuffer, filename, overwrite = true) {
    try {
      const formData = new FormData();
      formData.append('image', imageBuffer, filename);
      formData.append('overwrite', overwrite.toString());

      const response = await this.ctx.http.post(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/upload/image`, formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      this.log('info', '上传图片到 ComfyUI 成功', { filename, overwrite });
      return {
        success: true,
        data: response,
        message: 'Image uploaded successfully'
      };
    } catch (error) {
      this.log('error', '上传图片到 ComfyUI 失败', { filename, error: error.message });
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to upload image'
      };
    }
  }

  /**
   * 建立WebSocket连接
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const url = `${this.isSecureConnection ? 'wss' : 'ws'}://${this.serverEndpoint}/ws?clientId=${this.clientId}`;
      this.ws = new WebSocket(url, {
        perMessageDeflate: false,
      });

      this.ws.on('open', () => {
        this.log('info', 'WebSocket 连接已建立', { url });
        resolve();
      });

      this.ws.on('close', () => {
        this.log('warn', 'WebSocket 连接已关闭');
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        this.log('error', 'WebSocket 连接错误', { error: err.message });
        reject(err);
      });

      this.ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const message = JSON.parse(data.toString());
            this._handleWebSocketMessage(message);
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
          }
        }
      });
    });
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
      const response = await this.ctx.http.post(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/prompt`, {
        prompt,
        client_id: this.clientId
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
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

      const response = await this.ctx.http.get(url);

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
      const response = await this.ctx.http.get(url, { responseType: 'arraybuffer' });

      this.log('info', '获取生成图片成功', { filename, subfolder, type });
      return {
        success: true,
        data: response,
        buffer: Buffer.from(response)
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

      const onMessage = async (data, isBinary) => {
        if (isBinary) return;

        try {
          const message = JSON.parse(data.toString());
          const messageData = message.data;

          // 检查是否是我们等待的prompt完成消息
          if (message.type === 'executing' &&
            messageData.prompt_id === promptId &&
            messageData.node === null) {

            clearTimeout(timeout);
            this.ws?.off('message', onMessage);

            // 获取执行历史和结果
            const historyResult = await this.getHistory(promptId);
            if (!historyResult.success) {
              reject(new Error('Failed to get execution history'));
              return;
            }

            const history = historyResult.data;
            const outputs = {};

            // 处理输出结果
            for (const nodeId of Object.keys(history.outputs || {})) {
              const nodeOutput = history.outputs[nodeId];
              if (nodeOutput.images) {
                const images = [];
                for (const imageInfo of nodeOutput.images) {
                  if (imageInfo.type === 'output') {
                    const imageResult = await this.getImage(
                      imageInfo.filename,
                      imageInfo.subfolder,
                      imageInfo.type
                    );

                    if (imageResult.success) {
                      images.push({
                        filename: imageInfo.filename,
                        subfolder: imageInfo.subfolder,
                        type: imageInfo.type,
                        buffer: imageResult.buffer,
                        data: imageResult.data
                      });
                    }
                  }
                }
                outputs[nodeId] = { images };
              }
            }

            this.log('info', '工作流执行完成', { promptId });
            resolve({
              success: true,
              prompt_id: promptId,
              outputs,
              history,
              message: 'Execution completed successfully'
            });
          }
        } catch (err) {
          clearTimeout(timeout);
          this.ws?.off('message', onMessage);
          reject(err);
        }
      };

      this.ws.on('message', onMessage);
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

  /**
   * 用户上传JSON格式的prompt文本，执行该prompt工作流
   * 执行后轮询，直到成功后返回服务器的响应值
   * @param {Object} workflowJson - JSON格式的prompt
   * @param {string} userPrompt - 用户输入的prompt
   * @param {Object} options - 执行选项
   * @param {boolean} options.avoidCache - 是否避免缓存，默认true
   * @returns {Promise<Object>} 执行结果
   */
  async executePromptWorkflow(workflowJson: any, userPrompt: string, options: any = {}) {
    const { avoidCache = true } = options;

    try {

      // 0. 修改prompt
      const newSeedPrompt = this._modifyPromptToAvoidCache(workflowJson, avoidCache);
      const promptString = JSON.stringify(newSeedPrompt);
      if (!promptString.includes(PROMPT_PLACEHOLDER)) {
        this.log('warn', '工作流中未找到提示词占位符，将使用原始JSON', { placeholder: PROMPT_PLACEHOLDER });
      }
      const finalPrompt = JSON.parse(promptString.replaceAll(PROMPT_PLACEHOLDER, userPrompt))
      // 1. 建立WebSocket连接
      await this.connect();
      // 2. 提交prompt到队列
      const queueResult = await this.queuePrompt(finalPrompt);
      if (!queueResult.success) {
        await this.disconnect();
        return queueResult;
      }

      this.log('info', '等待工作流执行', { promptId: queueResult.prompt_id });
      // 3. 等待执行完成
      const executionResult = await this.waitForCompletion(queueResult.prompt_id);

      // 4. 断开连接
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
      const response = await this.ctx.http.post(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/interrupt`, null, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

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
      const response = await this.ctx.http.get(`${this.isSecureConnection ? 'https' : 'http'}://${this.serverEndpoint}/queue`);

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
