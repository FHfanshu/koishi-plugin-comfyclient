# koishi-plugin-comfyclient

一个为 [Koishi](https://koishi.chat/) 设计的 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 客户端插件：把任意 ComfyUI 工作流接到 QQ 等聊天平台上，用户用一条 `comfy` 指令就能出图。

本仓库基于 [flymyd/koishi-plugin-comfyui-client](https://github.com/flymyd/koishi-plugin-comfyui-client) 继续开发。

## 功能

- **任意工作流**：工作流以 JSON 存进配置（预设）或 `workflowDir` 下的文件，按名字用 `-w` 选择。
- **占位符**：`{{prompt}}`、`{{image}}`、`{{ratio}}`、`{{steps}}`、`{{vars 里的任意键}}`。
- **比例/尺寸**：`-r 3:4`、`--width`、`--height`，按原工作流面积换算出对齐 64 的宽高，写入所有带 `width/height` 的节点（`EmptyLatentImage`、`EmptyFlux2LatentImage` 等）。
- **模型切换**：`-m sft` 之类，通过 `modelAliases` 映射到具体 `unet_name`；未命中别名则把原文当文件名。
- **LoRA 开关**：`-l asian` 之类，通过 `loraAliases` 映射到 LoRA 文件名，写进工作流里的 `LoraLoaderModelOnly` 节点；不带 `-l` 时该节点会被自动摘掉。
- **步数覆盖**：`-s 30` 直接改写带数值型 `steps` 的节点。
- **图生图**：消息里附图或用 `-i <url>`，配合工作流里的 `{{image}}` 占位符；默认把图片内联成 base64，也可走 `/upload/image`。
- **frp 隧道友好**：支持 SakuraFrp 等「访问密码」表单认证，以及自动 HTTPS 的自签证书（跳过校验）。
- **LLM 提示词增强**：可选，接 OpenAI 兼容接口。

## 安装

在 Koishi 插件市场搜索 `comfyclient`，或：

```bash
yarn add koishi-plugin-comfyclient
```

## 指令

```
comfy <提示词> [-w 工作流] [-m 模型] [-l LoRA] [-r 比例] [-s 步数] [-i 图片] [--width N] [--height N] [--vars JSON] [--list]
```

示例：

```
comfy 雨夜霓虹街道上回头的少女 -w moss
comfy 雨夜霓虹街道上回头的少女 -w moss -m base -r 3:4 -s 50
comfy 雨夜霓虹街道上回头的少女 -l asian
comfy 换成水彩风格 -w relit -i https://example.com/a.png
comfy --list
```

选项也可以写在提示词后面（`comfy 提示词 -w moss -m base`）。

## 配置

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `serverEndpoint` | string | `127.0.0.1:8188` | ComfyUI 地址，`域名/IP:端口`，不要带协议 |
| `isSecureConnection` | boolean | false | 用 `https`/`wss` 连接（frp 自动 HTTPS 时必须开） |
| `accessPassword` | string | 空 | frp（如 SakuraFrp）隧道访问密码；插件会自己过认证页 |
| `allowInsecureTLS` | boolean | false | 跳过证书校验（frp 自签证书场景），WebSocket 同步生效 |
| `httpProxy` | string | 空 | 请求走指定代理，留空跟随环境变量 |
| `imageUploadMode` | `base64-first` / `image-first` | base64-first | 图生图的图片传输方式 |
| `uploadTimeoutMs` / `uploadMaxAttempts` | number | 15000 / 1 | 上传超时与重试 |
| `workflowDir` | string | `data/comfyworkflow` | 工作流文件目录（相对 Koishi 工作目录） |
| `defaultWorkflowName` | string | 空 | 不传 `-w` 时用哪个预设/文件；空则用 `workflowJSON` |
| `workflowPresets` | array | `[]` | 预设列表：`{name, description, content}`，`content` 是工作流 JSON 文本 |
| `workflowJSON` | textarea | 空 | 内联工作流（兜底） |
| `modelAliases` | array | `[]` | `{name, unet}`：`-m name` → `unet_name` |
| `loraAliases` | array | `[]` | `{name, lora}`：`-l name` → LoRA 文件名；不带 `-l` 时工作流里的 `LoraLoaderModelOnly` 节点会被摘掉 |
| `logEnabled` / `debug` | boolean | true / false | 日志等级 |

### 工作流要求

1. 正面提示词节点的 `text` 写成 `{{prompt}}`。
2. 需要图生图时，把图片占位符 `{{image}}` 放进对应节点（`LoadImage.image` 或自定义 base64 节点的输入）。
3. 宽高节点保持数值（比例换算靠它算面积），步数节点保持数值（`-s` 靠它覆盖）。
4. 输出节点用 `SaveImage` / `ImagePreview`，插件会自动找。
5. 需要 LoRA 时，在 `UNETLoader` 与下游（采样器/引导节点）之间串一个 `LoraLoaderModelOnly`，`lora_name` 留任意值即可：带 `-l` 时被覆盖，不带时整个节点被摘掉并把它下游的 `model` 引用接回上游。

### 模型别名 + 预设示例（MOSS Image）

```yaml
modelAliases:
  - { name: sft,  unet: moss_image_sft_int8_convrot.safetensors }
  - { name: base, unet: moss-image-base-dit-int8-convrot.safetensors }

loraAliases:
  - { name: asian, lora: moss-maleAsian_3305665_comfy.safetensors }
  - { name: acid,  lora: newacid_r32_e30_comfy.safetensors }
  - { name: sys,   lora: newacid_r32_e30_comfy.safetensors }
  - { name: xiuran, lora: 'character-ocs\3in1\xiuranmoqing-moss-step1050.safetensors' }   # 子目录要写全名，Windows 用反斜杠

workflowPresets:
  - name: moss
    description: MOSS Image 原生，默认 1024 / 25 步
    content: |
      {
        "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "moss_image_sft_int8_convrot.safetensors", "weight_dtype": "default" } },
        "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": "moss-image-qwen35-int8-convrot-native.safetensors", "type": "moss_image", "device": "default" } },
        "3": { "class_type": "VAELoader", "inputs": { "vae_name": "MOSS-Image-INT8\\flux2-vae.safetensors" } },
        "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{prompt}}", "clip": ["2", 0] } },
        "5": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["2", 0] } },
        "6": { "class_type": "EmptyFlux2LatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
        "11": { "class_type": "SkipLayerGuidanceDiTSimple", "inputs": { "model": ["12", 0], "double_layers": "", "single_layers": "22", "start_percent": 0, "end_percent": 1 } },
        "12": { "class_type": "LoraLoaderModelOnly", "inputs": { "lora_name": "moss-maleAsian_3305665_comfy.safetensors", "strength_model": 1.0, "model": ["1", 0] } },
        "7": { "class_type": "KSampler", "inputs": { "seed": 20261018, "steps": 25, "cfg": 3, "sampler_name": "euler", "scheduler": "sgm_uniform", "denoise": 1, "model": ["11", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0] } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["3", 0] } },
        "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "moss_bot" } }
      }
```

MOSS Image 用原生链路即可：采样倍率由模型自带的 shift 5 / multiplier 1 处理，**不要**再串 `ModelSamplingSD3`（默认 multiplier 1000 会出噪点图）；TE 需要键名为 `model.language_model.*` 的 `-native` 版本。

## 构建

```bash
yarn install
yarn build     # tsc -p tsconfig.json -> lib/
```

## 许可

MIT。原始版本 © [flymyd](https://github.com/flymyd)。
