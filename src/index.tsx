import { Context, Schema } from 'koishi'
import { ComfyUINode } from './ComfyUINode';
import OpenAI from "openai";

export const name = 'comfyui-client'

type LLMProvider = 'chatluna' | 'openai'

interface LLMBaseConfig {
  enabled: boolean;
  provider: LLMProvider;
  prompt: string;
  isSFW: boolean;
}

interface ChatLunaLLMConfig extends LLMBaseConfig {
  provider: 'chatluna';
  chatlunaModel: string;
}

interface OpenAILLMConfig extends LLMBaseConfig {
  provider: 'openai';
  endpoint: string;
  model: string;
  key: string;
}

type LLMConfig = ChatLunaLLMConfig | OpenAILLMConfig;

export interface Config {
  serverEndpoint: string;
  isSecureConnection: boolean;
  workflowJSON: string;
  picOutputNodeID: string;
  logEnabled: boolean;
  LLMSettings: LLMConfig;
}

const PROMPT_PLACEHOLDER = '{{prompt}}';

const defaultLLMPrompt = `
你是一个专注 Danbooru 风格二次元模型的提示词润色助手。接收用户的中文或英文描述，输出干净的英文标签式提示，适合动漫画风（如：1girl, solo, detailed eyes, best quality, dynamic lighting）。保持简洁高权重标签，补充场景、表情、动作、镜头、光影等细节。
- 输出英文逗号分隔标签，避免长句；适度加入画质提升词（best quality, masterpiece, highly detailed）。
- 不要包含 R18 内容或站点特殊符号；如果请求含成人倾向并开启 SFW，请返回字符0。
- 优先突出主体和画面元素，风格保持偏向日系插画。`

const chatLunaModelSelector = Schema.string()
  .role('select')
  .description('选择 ChatLuna 已配置的模型（留空则使用 ChatLuna 默认模型）')
  .default('');

export const Config: Schema<Config> = Schema.object({
  serverEndpoint: Schema.string().default('127.0.0.1:8188').description("ComfyUI服务器，格式：域名/IP:端口，默认：127.0.0.1:8188"),
  isSecureConnection: Schema.boolean().default(false).description("是否使用HTTPS连接，默认：false"),
  picOutputNodeID: Schema.string().default('53').description("图片在工作流中的输出节点ID，默认：53（示例工作流的 SaveImage 节点）"),
  workflowJSON: Schema.string().role('textarea').default('').description(`工作流JSON字符串；在正面提示节点使用占位符 ${PROMPT_PLACEHOLDER} 插入用户输入，可参考示例文件。`),
  logEnabled: Schema.boolean().default(true).description("是否记录与 ComfyUI 的详细日志"),
  LLMSettings: Schema.intersect([
    Schema.object({
      enabled: Schema.boolean().default(false).description("是否启用提示词润色"),
      provider: Schema.union([
        Schema.const('chatluna').description('使用 ChatLuna 模型'),
        Schema.const('openai').description('使用自定义 OpenAI 兼容模型')
      ] as const).default('chatluna'),
      prompt: Schema.string().role('textarea').default(defaultLLMPrompt).description("润色提示词（系统提示）"),
      isSFW: Schema.boolean().default(true).description("是否启用 SFW 过滤（返回字符0代表被过滤）")
    }),
    Schema.union([
      Schema.object({
        provider: Schema.const('chatluna'),
        chatlunaModel: chatLunaModelSelector,
      }),
      Schema.object({
        provider: Schema.const('openai'),
        endpoint: Schema.string().default('https://api.z.ai/api/paas/v4').description("OpenAI兼容LLM Endpoint，格式：域名/IP:端口"),
        model: Schema.string().default('glm-4.5-flash').description("LLM模型ID"),
        key: Schema.string().default('sk-******').description("LLM API Key"),
      }),
    ]),
  ]).description("LLM增强设置")
})

export function apply(ctx: Context) {
  const pluginLogger = ctx.logger('comfyui-client');
  const COMFYUI_SERVER = ctx.config.serverEndpoint;
  const IS_SECURE_CONNECTION = ctx.config.isSecureConnection;
  const LOG_ENABLED = ctx.config.logEnabled;

  ctx.command('comfy <userPrompt:text> ComfyUI绘图')
    .action(async (_, userPrompt) => {
      const comfyNode = new ComfyUINode(ctx, COMFYUI_SERVER, IS_SECURE_CONNECTION, pluginLogger, LOG_ENABLED);
      try {
        if (!userPrompt) {
          return '请提供提示词';
        }
        const promptJson = JSON.parse(ctx.config.workflowJSON);
        let finalUserPrompt = userPrompt;
        const llm = ctx.config.LLMSettings;

        if (llm.enabled) {
          let systemPrompt = llm.prompt;
          if (llm.isSFW) {
            systemPrompt = "[最高优先级]安全识别：如果用户请求含有 R18 的意图（露骨描述、性暗示、暴力、血腥或任何成人内容），请直接返回字符0。\n" + systemPrompt;
          }

          if (llm.provider === 'chatluna') {
            const chatlunaService = (ctx as any).chatluna;
            if (!chatlunaService) {
              pluginLogger?.warn('LLM 请求失败：未安装或未启用 chatluna 插件');
              return '未启用 chatluna，无法润色提示词';
            }
            const chosenModel = llm.chatlunaModel || chatlunaService.defaultModel || chatlunaService.model;
            if (!chosenModel) {
              pluginLogger?.warn('LLM 请求失败：未选择 chatluna 模型');
              return '请在配置中选择 chatluna 模型';
            }
            pluginLogger?.info(`使用 ChatLuna 模型润色提示词`, { model: chosenModel });
            const completion = await chatlunaService.createChatCompletion?.({
              model: chosenModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ]
            }) ?? await chatlunaService.chat?.({
              model: chosenModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ]
            });
            finalUserPrompt = completion?.choices?.[0]?.message?.content
              || completion?.content
              || completion?.text
              || finalUserPrompt;
          } else {
            const client = new OpenAI({
              baseURL: (llm as OpenAILLMConfig).endpoint,
              apiKey: (llm as OpenAILLMConfig).key,
            });
            pluginLogger?.info(`使用 OpenAI 兼容模型润色提示词`, { model: (llm as OpenAILLMConfig).model });
            const completion = await client.chat.completions.create({
              model: (llm as OpenAILLMConfig).model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ]
            });
            finalUserPrompt = completion.choices?.[0]?.message?.content || finalUserPrompt;
          }

          if (finalUserPrompt === '0') {
            pluginLogger?.warn('提示词因 SFW 过滤被拒绝');
            return 'R18内容已被过滤';
          }
          pluginLogger?.debug?.('润色后的提示词', { finalUserPrompt });
        }

        const result: any = await comfyNode.executePromptWorkflow(promptJson, finalUserPrompt);
        if (result.success) {
          const finalResult = result.outputs[ctx.config.picOutputNodeID].images.map(item => ({
            filename: item.filename,
            buffer: item.buffer
          }))
          const imageBuffer = finalResult[0].buffer;
          const base64Image = imageBuffer.toString('base64');
          const dataUri = `data:image/png;base64,${base64Image}`;
          pluginLogger?.info('工作流执行成功', { promptId: result.prompt_id });
          return <img src={dataUri} />
        } else {
          pluginLogger?.error('工作流执行失败', { error: result.error });
          return '执行失败';
        }
      } catch (error) {
        pluginLogger?.error('从JSON文件执行工作流时发生错误', { error });
        return '执行失败';
      }
    })
}
