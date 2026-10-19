import { Context, Schema } from "koishi";
import { ComfyUINode } from "./ComfyUINode";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const name = "comfyui-client";

export interface WorkflowPreset {
  name: string;
  description?: string;
  content: string;
  /** 工作流 JSON 在 ComfyUI 服务器 user 目录下的相对路径；非空时优先从服务器拉取 */
  remotePath: string;
}

export interface ModelAlias {
  name: string;
  unet: string;
}

export interface LoraAlias {
  name: string;
  lora: string;
}

export interface Config {
  serverEndpoint: string;
  isSecureConnection: boolean;
  /** frp（如 SakuraFrp）隧道访问密码；留空则不认证 */
  accessPassword?: string;
  /** frp 自动 HTTPS 的证书通常不被信任，开启后跳过证书校验 */
  allowInsecureTLS?: boolean;
  httpProxy?: string;
  workflowDir: string;
  defaultWorkflowName: string;
  workflowPresets: WorkflowPreset[];
  /**
   * 模型别名表：Bot 用户用 `-m sft` / `-m base` 时映射到具体 unet 文件名。
   * 未命中别名时把 `-m` 的原文直接写进 unet_name。
   */
  modelAliases: ModelAlias[];
  /**
   * LoRA 别名表：Bot 用户用 `-l asian` 时映射到具体 LoRA 文件名。
   * 未命中别名时把 `-l` 的原文直接写进 lora_name；不带 `-l` 时工作流里的 LoRA 节点会被摘掉。
   */
  loraAliases: LoraAlias[];
  workflowJSON: string;
  /**
   * 图片上传方式：
   * - "base64-first"（默认）：直接将图片内联为 base64，占位符 {{image}} 写成 data URI。
   * - "image-first"：优先上传到 ComfyUI，失败时再回退 base64。
   */
  imageUploadMode?: "base64-first" | "image-first";
  uploadTimeoutMs?: number;
  uploadMaxAttempts?: number;
  logEnabled: boolean;
  debug: boolean;
}

type WorkflowResolveResult = {
  text: string;
  source: string;
  name: string;
  preset?: WorkflowPreset;
};

const PROMPT_PLACEHOLDER = "{{prompt}}";

const ensureDir = async (dir: string) => {
  await fs.promises.mkdir(dir, { recursive: true });
};

const sanitizeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "");

const md5 = (text: string | Buffer) => crypto.createHash("md5").update(text).digest("hex");

async function listWorkflows(dir: string) {
  await ensureDir(dir);
  const files = await fs.promises.readdir(dir);
  const list = [] as { name: string; updatedAt: number }[];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const stat = await fs.promises.stat(path.join(dir, file));
    list.push({ name: path.parse(file).name, updatedAt: stat.mtimeMs });
  }
  return list;
}

async function readWorkflow(dir: string, name: string) {
  const safe = sanitizeName(name);
  const filePath = path.join(dir, `${safe}.json`);
  const content = await fs.promises.readFile(filePath, "utf-8");
  return content;
}

async function resolveWorkflowText(
  ctxConfig: Config,
  optionsWorkflow: string | undefined,
  logger: any,
  workflowDirAbs: string,
  comfyNode: ComfyUINode
): Promise<WorkflowResolveResult> {
  const desiredName = optionsWorkflow || ctxConfig.defaultWorkflowName;
  const preset = desiredName ? ctxConfig.workflowPresets?.find((p) => p.name === desiredName) : undefined;

  // 1) 预设指向服务器路径：优先从推理机拉取，避免把 JSON 正文放在 koishi.yml
  const remotePath = preset?.remotePath?.trim();
  if (preset && remotePath) {
    try {
      const text = await comfyNode.fetchUserData(remotePath);
      logger?.info?.("使用服务器工作流", { desiredName, source: `server:${remotePath}` });
      return { text, source: `server:${remotePath}`, name: desiredName, preset };
    } catch (err) {
      if (!preset.content?.trim()) {
        logger?.error?.("读取服务器工作流失败，预设没有可回退的 content", {
          desiredName,
          remotePath,
          error: (err as any)?.message,
        });
        throw new Error(`读取服务器工作流失败（${remotePath}）：${(err as any)?.message || err}`);
      }
      logger?.warn?.("读取服务器工作流失败，回退预设 content", {
        desiredName,
        remotePath,
        error: (err as any)?.message,
      });
      return { text: preset.content, source: "preset", name: desiredName, preset };
    }
  }

  if (preset?.content?.trim()) {
    logger?.info?.("使用工作流预设", { desiredName, source: "preset" });
    return { text: preset.content, source: "preset", name: desiredName, preset };
  }

  if (desiredName) {
    try {
      const text = fs.readFileSync(path.join(workflowDirAbs, `${sanitizeName(desiredName)}.json`), "utf-8");
      logger?.info?.("使用工作流文件", { desiredName, source: "file" });
      return { text, source: "file", name: desiredName };
    } catch (err) {
      logger?.warn?.("读取工作流文件失败，回退配置字段", { desiredName, error: (err as any)?.message });
    }
  }

  return { text: ctxConfig.workflowJSON, source: "config", name: "inline-config" };
}

function pickOutputNode(outputs: Record<string, any>, workflowJson: any, logger?: any) {
  const hasImages = (node: any) => node && Array.isArray(node.images) && node.images.length > 0;

  const preferredIds = Object.keys(workflowJson || {})
    .filter((id) => {
      const cls = (workflowJson as any)[id]?.class_type;
      return cls === "SaveImage" || cls === "ImagePreview";
    })
    .filter((id) => hasImages(outputs?.[id]));

  if (preferredIds.length) {
    const nodeId = preferredIds[0];
    logger?.info?.("自动匹配到 SaveImage/ImagePreview 输出节点", {
      autoNodeId: nodeId,
      classType: (workflowJson as any)[nodeId]?.class_type,
    });
    return { nodeId, node: outputs[nodeId], reason: "auto-save-image" };
  }

  const anyNodeId = Object.keys(outputs || {}).find((id) => hasImages(outputs[id]));
  if (anyNodeId) {
    logger?.warn?.("未找到 SaveImage/ImagePreview 节点，使用第一个有图片的节点", { autoNodeId: anyNodeId });
    return { nodeId: anyNodeId, node: outputs[anyNodeId], reason: "fallback-first-image" };
  }

  return null;
}

function parseRatio(text?: string) {
  if (!text) return null;
  const parts = text.split(":").map((p) => Number(p));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n) || n <= 0)) return null;
  return { w: parts[0], h: parts[1] };
}

function roundTo64(value: number) {
  return Math.max(64, Math.round(value / 64) * 64);
}

function applyOutputDimensions(promptJson: any, width?: number, height?: number, ratioText?: string, logger?: any) {
  const clone = JSON.parse(JSON.stringify(promptJson));

  const findBaseSize = () => {
    for (const node of Object.values<any>(clone)) {
      const w = (node as any)?.inputs?.width;
      const h = (node as any)?.inputs?.height;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) return { w, h };
    }
    return null;
  };

  const base = findBaseSize() || { w: 832, h: 1216 };
  const area = base.w * base.h;

  const ratio = parseRatio(ratioText);
  let targetW = typeof width === "number" && width > 0 ? width : undefined;
  let targetH = typeof height === "number" && height > 0 ? height : undefined;

  if (ratio) {
    const calcW = Math.sqrt((area * ratio.w) / ratio.h);
    const calcH = Math.sqrt((area * ratio.h) / ratio.w);
    targetW = targetW ?? roundTo64(calcW);
    targetH = targetH ?? roundTo64(calcH);
  }

  targetW = targetW ?? base.w;
  targetH = targetH ?? base.h;

  let touched = false;
  for (const [, node] of Object.entries<any>(clone)) {
    const inputs = (node as any).inputs;
    if (inputs && typeof inputs === "object") {
      if (typeof inputs.width !== "undefined") {
        inputs.width = targetW;
        touched = true;
      }
      if (typeof inputs.height !== "undefined") {
        inputs.height = targetH;
        touched = true;
      }
    }
  }

  if (touched) {
    logger?.info?.("已应用输出尺寸", { width: targetW, height: targetH, ratio: ratioText });
  }

  return clone;
}

function applySamplerSteps(promptJson: any, steps: number | undefined, logger?: any) {
  if (typeof steps !== "number" || !Number.isFinite(steps) || steps <= 0) return promptJson;

  const clone = JSON.parse(JSON.stringify(promptJson));
  let touched = false;
  for (const [, node] of Object.entries<any>(clone)) {
    const inputs = (node as any)?.inputs;
    if (inputs && typeof inputs === "object" && typeof inputs.steps === "number") {
      inputs.steps = Math.round(steps);
      touched = true;
    }
  }

  logger?.info?.("已应用采样步数", { steps: Math.round(steps), touched });
  return clone;
}

function applyModelOverride(promptJson: any, modelRaw: string | undefined, aliases: ModelAlias[] | undefined, logger?: any) {
  const wanted = (modelRaw || "").trim();
  if (!wanted) return promptJson;

  const alias = (aliases || []).find((item) => item.name?.toLowerCase() === wanted.toLowerCase());
  const unetName = alias?.unet || wanted;

  const clone = JSON.parse(JSON.stringify(promptJson));
  let touched = false;
  for (const [, node] of Object.entries<any>(clone)) {
    const inputs = (node as any)?.inputs;
    if (inputs && typeof inputs === "object" && typeof inputs.unet_name === "string") {
      inputs.unet_name = unetName;
      touched = true;
    }
  }

  logger?.info?.("已应用模型覆盖", { requested: wanted, resolvedAlias: alias?.name || null, unetName, touched });
  return clone;
}

const LORA_CLASS = "LoraLoaderModelOnly";

/**
 * 工作流里带一个 `LoraLoaderModelOnly` 节点承载 `-l`：带了就填名字，没带就把节点摘掉、
 * 把它的下游 model 引用接回上游，避免空 lora_name 触发 ComfyUI 的 value_not_in_list。
 */
function applyLoraOverride(promptJson: any, loraRaw: string | undefined, aliases: LoraAlias[] | undefined, logger?: any) {
  const clone = JSON.parse(JSON.stringify(promptJson));
  const loraNodeId = Object.keys(clone).find((id) => clone[id]?.class_type === LORA_CLASS);
  if (!loraNodeId) return clone;

  const wanted = (loraRaw || "").trim();
  if (!wanted) {
    const upstream = clone[loraNodeId].inputs?.model;
    if (!Array.isArray(upstream)) return clone;
    for (const node of Object.values<any>(clone)) {
      const inputs = (node as any)?.inputs;
      if (!inputs || typeof inputs !== "object") continue;
      for (const [key, value] of Object.entries<any>(inputs)) {
        if (Array.isArray(value) && value[0] === loraNodeId) inputs[key] = upstream;
      }
    }
    delete clone[loraNodeId];
    logger?.debug?.("未指定 LoRA，已跳过 LoRA 节点");
    return clone;
  }

  const alias = (aliases || []).find((item) => item.name?.toLowerCase() === wanted.toLowerCase());
  const loraName = alias?.lora || wanted;
  clone[loraNodeId].inputs.lora_name = loraName;
  logger?.info?.("已应用 LoRA", { requested: wanted, resolvedAlias: alias?.name || null, loraName });
  return clone;
}

function workflowExpectsPureBase64(promptJson: any) {
  const placeholderPattern = /\{\{\s*image\s*\}\}/i;
  const scanInputs = (inputs: any) => {
    if (!inputs || typeof inputs !== "object") return false;
    return Object.entries(inputs).some(([key, value]) => {
      if (typeof value === "string" && placeholderPattern.test(value)) {
        const keyLower = key.toLowerCase();
        if (keyLower.includes("base64")) return true;
      }
      return false;
    });
  };

  return Object.values<any>(promptJson || {}).some((node) => {
    if (!node || typeof node !== "object") return false;
    if (typeof node.class_type === "string" && node.class_type.toLowerCase().includes("base64")) {
      if (scanInputs(node.inputs)) return true;
    }
    return scanInputs(node.inputs);
  });
}

function toBufferFromDataUri(uri: string) {
  const match = uri.match(/^data:(.+);base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
}

function toBufferFromBase64Uri(text: string) {
  const match = text.match(/^base64:(?:\/\/)?(.+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function deriveFilenameFromUrl(input: string, fallback = "upload.png") {
  if (!input) return fallback;
  try {
    const url = new URL(input);
    const name = url.pathname.split("/").filter(Boolean).pop();
    if (name) return name;
  } catch {
    /* ignore */
  }
  const cleanTail = input.split(/[?#]/)[0]?.split("/").pop();
  return cleanTail || fallback;
}

const truncate = (text: string, max = 160) => (text && text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * 当用户把选项写在文本后面时（例如：`comfy 重新照明 -w relit`），Koishi 的 `[userPrompt:text]` 会把后面的内容全部吞掉，
 * 造成选项解析失败。这里尝试从原始提示词中“救回”常用选项，并同时把它们从提示词里剔除，保持向后兼容。
 */
function recoverInlineOptions(rawPrompt: string | undefined, parsedOptions: any) {
  if (!rawPrompt) return { prompt: "", recovered: {} as Record<string, any> };

  let prompt = rawPrompt;
  const recovered: Record<string, any> = {};

  type Rule = {
    key: keyof Config | "workflow" | "image" | "ratio" | "steps" | "vars" | "list" | "width" | "height" | "model" | "noexpand" | "lora";
    regex: RegExp;
    value?: any;
  };
  const rules: Rule[] = [
    // 选项前面常常直接跟中文（`正对镜头。-l doc`），所以只要求前一个字符不是字母/数字/短横线，
    // 而不是像以前那样必须是行首或空白。
    { key: "workflow", regex: /(?<![\w-])--workflow\s+([^\s]+)/i },
    { key: "workflow", regex: /(?<![\w-])-w\s+([^\s]+)/i },
    { key: "model", regex: /(?<![\w-])--model\s+([^\s]+)/i },
    { key: "model", regex: /(?<![\w-])-m\s+([^\s]+)/i },
    { key: "lora", regex: /(?<![\w-])--lora\s+([^\s]+)/i },
    { key: "lora", regex: /(?<![\w-])-l\s+([^\s]+)/i },
    { key: "ratio", regex: /(?<![\w-])-r\s+([0-9]+:[0-9]+)/i },
    { key: "steps", regex: /(?<![\w-])-s\s+([0-9]+)/i },
    { key: "width", regex: /(?<![\w-])--width\s+([0-9]+)/i },
    { key: "height", regex: /(?<![\w-])--height\s+([0-9]+)/i },
    { key: "vars", regex: /(?<![\w-])--vars\s+(\{.*?\})(?=\s|$)/i },
    { key: "image", regex: /(?<![\w-])-i\s+([^\s]+)/i },
    { key: "list", regex: /(?<![\w-])--list(?=\s|$)/i, value: true },
    { key: "noexpand", regex: /(?<![\w-])--noexpand(?=\s|$)/i, value: true },
    { key: "noexpand", regex: /(?<![\w-])-n(?=\s|$)/i, value: true },
  ];

  for (const rule of rules) {
    // 已通过 Koishi 解析出的选项不再重复解析
    if (typeof (parsedOptions as any)?.[rule.key] !== "undefined") continue;
    const match = prompt.match(rule.regex);
    if (match && match.index !== undefined) {
      const val = rule.value === true ? true : match[1];
      recovered[rule.key] = val;
      // 从提示词中移除该片段，避免污染真实提示
      prompt = `${prompt.slice(0, match.index)} ${prompt.slice(match.index + match[0].length)}`.replace(/\s+/g, " ").trim();
    }
  }

  return { prompt: prompt.trim(), recovered };
}

function summarizeElements(list: any[] | undefined) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).map((el, idx) => ({
    idx,
    type: (el as any)?.type || (el as any)?.attrs?.type,
    url:
      truncate(
        (el as any)?.attrs?.url ||
          (el as any)?.attrs?.src ||
          (el as any)?.attrs?.file ||
          (el as any)?.src ||
          ""
      ) || undefined,
    hasUrl: !!((el as any)?.attrs?.url || (el as any)?.attrs?.src || (el as any)?.attrs?.file || (el as any)?.src),
    hasBase64: typeof (el as any)?.attrs?.file === "string" && /^base64:/i.test((el as any).attrs.file || ""),
    base64Len: typeof (el as any)?.attrs?.file === "string" ? (el as any).attrs.file.length : 0,
    keys: Object.keys(el || {}).slice(0, 4),
  }));
}

function findImageElement(
  session: any,
  logger?: (level: "debug" | "info" | "warn", message: string, meta?: Record<string, any>) => void
): { url: string; name?: string } | null {
  const listCandidates: any[] = [];

  const maybeLists = [
    session?.message?.elements,
    session?.elements,
    (session as any)?.event?.message?.elements,
    (session as any)?.event?.elements,
  ];
  for (const list of maybeLists) {
    if (Array.isArray(list)) listCandidates.push(...list);
  }

  // 一些适配器（如 QQ 频道）将图片放在 attachments 里
  const attachments =
    (session as any)?.event?.message?.attachments ||
    (session as any)?.message?.attachments ||
    (session as any)?.attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      listCandidates.push({ type: "image", attrs: att });
    }
  }

  logger?.("debug", "收到的潜在图片元素", {
    candidateCount: listCandidates.length,
    samples: summarizeElements(listCandidates),
    urls: listCandidates
      .map((el) => (el as any)?.attrs?.url || (el as any)?.attrs?.src || (el as any)?.attrs?.file || (el as any)?.src)
      .filter(Boolean)
      .slice(0, 10)
      .map((u) => truncate(String(u), 180)),
  });

  const image = listCandidates.find((el: any) => {
    const t = (el?.type || el?.attrs?.type || "").toString().toLowerCase();
    const hasUrl = (el as any)?.attrs?.url || (el as any)?.attrs?.src || (el as any)?.attrs?.file || (el as any)?.src;
    return hasUrl && (t === "image" || t === "img" || t === "imageMessage" || t === "image_message" || !t);
  });
  if (!image) return null;

  const url = (image as any).attrs?.url || (image as any).attrs?.src || (image as any).attrs?.file || (image as any).src;
  const name =
    (image as any).attrs?.title || (image as any).attrs?.filename || (image as any).attrs?.name || (image as any).name;

  return url ? { url, name } : null;
}

async function resolveIncomingImage(
  ctx: Context,
  session: any,
  optionImage: string | undefined,
  cacheDir: string | undefined,
  logFn?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, any>) => void
): Promise<{ buffer: Buffer; filename: string } | null> {
  let source = optionImage?.trim();
  let hintedName: string | undefined;

  const foundCandidate = findImageElement(session, (level, message, meta) => logFn?.(level, message, meta));

  if (!source && foundCandidate) {
    source = foundCandidate.url;
    hintedName = foundCandidate.name;
    logFn?.("info", "使用会话中的图片元素", { url: source, name: hintedName });
  }

  if (source && optionImage) {
    logFn?.("debug", "使用指令参数提供的图片", { url: truncate(optionImage, 200) });
  }

  if (!source && foundCandidate === null) {
    logFn?.("debug", "未解析到图片URL，但收到的候选元素已记录");
  }

  if (!source) return null;

  const filename = deriveFilenameFromUrl(source, hintedName || "upload.png");
  const safeFilename = filename.includes(".") ? filename : `${filename}.png`;

  const ensureCacheDir = async () => {
    if (!cacheDir) return;
    await ensureDir(cacheDir);
  };

  const cacheKey = md5(source);
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}-${safeFilename}`) : null;

  const tryReadCache = async () => {
    if (!cachePath) return null;
    try {
      await ensureCacheDir();
      const buf = await fs.promises.readFile(cachePath);
      logFn?.("info", "命中图片缓存", { cachePath, filename: safeFilename });
      return buf;
    } catch {
      return null;
    }
  };

  const writeCache = async (buf: Buffer) => {
    if (!cachePath) return;
    try {
      await ensureCacheDir();
      await fs.promises.writeFile(cachePath, buf);
      logFn?.("debug", "写入图片缓存成功", { cachePath, size: buf.length });
    } catch (err) {
      logFn?.("warn", "写入图片缓存失败，已忽略", { cachePath, error: (err as any)?.message || err });
    }
  };

  const cached = await tryReadCache();
  if (cached) {
    return { buffer: cached, filename: safeFilename };
  }
  try {
    if (source.startsWith("data:")) {
      const buffer = toBufferFromDataUri(source);
      if (!buffer) throw new Error("无法解析 data URI 图片");
      logFn?.("info", "解析 data URI 图片成功", { filename: safeFilename });
      await writeCache(buffer);
      return { buffer, filename: safeFilename };
    }

    if (/^base64:(?:\/\/)?/i.test(source)) {
      const buffer = toBufferFromBase64Uri(source);
      if (!buffer) throw new Error("无法解析 base64 图片");
      logFn?.("info", "解析 base64 图片成功", { filename: safeFilename });
      await writeCache(buffer);
      return { buffer, filename: safeFilename };
    }

    if (source.startsWith("file://")) {
      const filePath = decodeURIComponent(source.replace("file://", ""));
      const buffer = await fs.promises.readFile(filePath);
      logFn?.("info", "读取本地文件图片成功", { filePath });
      const resolvedName = path.basename(filePath) || safeFilename;
      return { buffer, filename: resolvedName.includes(".") ? resolvedName : `${resolvedName}.png` };
    }

    const response = await ctx.http.get<ArrayBuffer>(source, { responseType: "arraybuffer" });
    const buffer = Buffer.isBuffer(response) ? response : Buffer.from(response as ArrayBuffer);
    logFn?.("info", "下载网络图片成功", { url: source, filename: safeFilename });
    await writeCache(buffer);
    return { buffer, filename: safeFilename };
  } catch (error) {
    logFn?.("warn", "下载图片失败，已忽略图片输入", { url: source, error: (error as any)?.message || error });
    return null;
  }
}

export const Config: Schema<Config> = Schema.object({
  serverEndpoint: Schema.string().default("127.0.0.1:8188").description("ComfyUI服务器，格式：域名/IP:端口，默认：127.0.0.1:8188"),
  isSecureConnection: Schema.boolean().default(false).description("是否使用HTTPS连接，默认：false"),
  accessPassword: Schema.string().default("").description("frp 隧道访问密码（SakuraFrp 等）；留空表示不需要认证"),
  allowInsecureTLS: Schema.boolean().default(false).description("跳过 HTTPS 证书校验（frp 自动 HTTPS 的自签证书需要开启）"),
  httpProxy: Schema.string().default("").description("上传/请求走指定 HTTP(S) 代理（留空则跟随环境变量 http_proxy/https_proxy）"),
  imageUploadMode: Schema.union([
    Schema.const("base64-first" as const).description("优先使用 base64 内联（默认）"),
    Schema.const("image-first" as const).description("优先上传图片到 ComfyUI，失败回退 base64"),
  ])
    .default("base64-first")
    .description("图片上传方式：base64 优先或 image 优先"),
  uploadTimeoutMs: Schema.number().default(15000).description("上传图片单次超时时间（毫秒）。默认 15000，便于长链路下快速回退到 base64。"),
  uploadMaxAttempts: Schema.number().default(1).description("上传图片最大重试次数。默认 1（失败立即走 base64 回退）；设为 >1 可在弱网下多试几次。"),
  logEnabled: Schema.boolean().default(true).description("是否记录与 ComfyUI 的详细日志"),
  debug: Schema.boolean().default(false).description("调试模式：打印 debug 级别的中间件日志"),
  workflowDir: Schema.string().default("data/comfyworkflow").description("工作流存储目录（相对 Koishi 运行目录），默认：data/comfyworkflow"),
  defaultWorkflowName: Schema.string().default("").description("默认使用的工作流名（可匹配预设或文件，不含扩展名）。为空则使用下方 workflowJSON 字符串"),
  workflowPresets: Schema.array(
    Schema.object({
      name: Schema.string().description("工作流名称"),
      description: Schema.string().default("").description("说明（可选）"),
      content: Schema.string().role("textarea").default("").description(`工作流 JSON 内容，含 ${PROMPT_PLACEHOLDER} 等占位符；配置了 remotePath 时可留空`),
      remotePath: Schema.string().default("").description("工作流 JSON 在 ComfyUI 服务器 user 目录下的相对路径（如 bot_workflows/moss_expand.json）。设置后优先从服务器拉取，content 可留空。"),
    })
  )
    .default([])
    .description("工作流预设列表（Koishi 控制台维护，无内置 WebUI）"),
  modelAliases: Schema.array(
    Schema.object({
      name: Schema.string().description("别名（Bot 用户用 -m 传入）"),
      unet: Schema.string().description("实际 unet 文件名"),
    })
  )
    .default([])
    .description("模型别名表：`-m sft` 之类映射到具体 unet 文件名；未命中则把原文当文件名"),
  loraAliases: Schema.array(
    Schema.object({
      name: Schema.string().description("别名（Bot 用户用 -l 传入）"),
      lora: Schema.string().description("实际 LoRA 文件名"),
    })
  )
    .default([])
    .description("LoRA 别名表：`-l asian` 之类映射到具体 LoRA 文件名；未命中则把原文当文件名，不带 -l 时工作流里的 LoRA 节点会被摘掉"),
  workflowJSON: Schema.string()
    .role("textarea")
    .default("")
    .description(`工作流JSON字符串；在正面提示节点使用占位符 ${PROMPT_PLACEHOLDER} 插入用户输入，可参考示例文件。`),
});

export function apply(ctx: Context, config: Config) {
  const pluginLogger = ctx.logger("comfyui-client");
  const COMFYUI_SERVER = config.serverEndpoint;
  const IS_SECURE_CONNECTION = config.isSecureConnection;
  const HTTP_PROXY = config.httpProxy?.trim() || undefined;
  const UPLOAD_TIMEOUT_MS = typeof config.uploadTimeoutMs === "number" && config.uploadTimeoutMs > 0 ? config.uploadTimeoutMs : 15000;
  const UPLOAD_MAX_ATTEMPTS = typeof config.uploadMaxAttempts === "number" && config.uploadMaxAttempts > 0 ? config.uploadMaxAttempts : 1;
  const LOG_ENABLED = config.logEnabled;
  const DEBUG_ENABLED = config.debug;
  const IMAGE_UPLOAD_MODE = config.imageUploadMode === "image-first" ? "image-first" : "base64-first";
  if (config.allowInsecureTLS) {
    // frp 自动 HTTPS 用的是自签证书，Node 默认会拒绝；只影响本进程出站请求
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const WORKFLOW_DIR = path.isAbsolute(config.workflowDir)
    ? config.workflowDir
    : path.join(ctx.baseDir || process.cwd(), config.workflowDir);
  const IMAGE_CACHE_DIR = path.join(WORKFLOW_DIR, "imgcache");

  const log = (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, any>) => {
    if (!LOG_ENABLED) return;
    const metaText = meta ? JSON.stringify(meta) : "";
    const text = metaText ? `${message} ${metaText}` : message;

    // 1) 仍然调用 Koishi logger（若等级被过滤则可能看不到）
    if (pluginLogger) {
      if (level !== "debug" || DEBUG_ENABLED) {
        (pluginLogger as any)[level]?.(text);
      }
      // 当 debug 开启时，额外用 info 级别镜像一份，绕过 Koishi 等级过滤
      if (level === "debug" && DEBUG_ENABLED) {
        (pluginLogger as any)["info"]?.(`[debug] ${text}`);
      }
    }

    // 2) 直接输出到 stdout，绕过 Koishi 等级过滤（仅 debug 时启用）
    if (level === "debug" && DEBUG_ENABLED) {
      const prefix = "[comfyui-client][debug]";
      console.log(`${prefix} ${text}`);
    }
  };

  ensureDir(WORKFLOW_DIR).catch((err) => {
    pluginLogger?.error?.("创建工作流目录失败", { dir: WORKFLOW_DIR, error: err?.message || err });
  });
  ensureDir(IMAGE_CACHE_DIR).catch((err) => {
    pluginLogger?.error?.("创建图片缓存目录失败", { dir: IMAGE_CACHE_DIR, error: err?.message || err });
  });

  // 指令识别前清理粘连：`comfy【…`（缺空格或夹了零宽字符）会让 Koishi 认不出指令名
  const normalizeCommandGap = (session: any) => {
    const raw = String(session.content || "");
    let fixed = raw.replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\u3000/g, " ");
    fixed = fixed.replace(/^(comfy)(?=[^\s])/i, "$1 ");
    if (fixed === raw) return false;
    const extras = (session.elements || []).filter((el: any) => el.type !== "text");
    session.content = fixed;
    if (extras.length) session.elements = [...(session.elements || []), ...extras];
    return true;
  };

  // 排查「指令没反应」用：debug 打开时把每条消息的会话坐标打出来
  ctx.middleware((session: any, next: any) => {
    const repaired = normalizeCommandGap(session);
    if (DEBUG_ENABLED) {
      log("debug", "收到消息", {
        platform: session.platform,
        selfId: session.selfId,
        guildId: session.guildId,
        channelId: session.channelId,
        userId: session.userId,
        repaired,
        content: String(session.content || "").slice(0, 160),
      });
    }
    return next();
  }, true);

  ctx
    .command("comfy [userPrompt:text] ComfyUI绘图/改图")
    .option("workflow", "-w <workflow:string> 指定工作流名（可为预设或文件名）")
    .option("noexpand", "-n 跳过提示词扩写，直接使用 mossraw 预设")
    .option("model", "-m <model:string> 指定模型（别名如 sft/base，或直接给 unet 文件名）")
    .option("lora", "-l <lora:string> 叠加 LoRA（别名如 asian，或直接给文件名）；不带则跳过工作流里的 LoRA 节点")
    .option("ratio", "-r <ratio:string> 指定输出比例，占位符 {{ratio}} 可在工作流中使用")
    .option("vars", "--vars <json:string> 以 JSON 提供额外占位符，如 {\"ratio\":\"16:9\",\"style\":\"film\"}")
    .option("width", "--width <width:number> 指定输出宽度（优先级高于比例）")
    .option("height", "--height <height:number> 指定输出高度（优先级高于比例）")
    .option("steps", "-s <steps:number> 指定采样步数，占位符 {{steps}} 可在工作流中使用")
    .option("image", "-i <image:string> 指定图像URL，或直接在消息中附带图片")
    .option("list", "--list 显示可用工作流（预设+文件）")
    .action(async ({ session, options }, userPrompt) => {
      const comfyNode = new ComfyUINode(
        ctx,
        COMFYUI_SERVER,
        IS_SECURE_CONNECTION,
        pluginLogger,
        LOG_ENABLED,
        DEBUG_ENABLED,
        null,
        HTTP_PROXY,
        config.accessPassword,
        !!config.allowInsecureTLS
      );
      try {
        // 兼容把选项写在文本末尾的写法：comfy 提示词 -w xxx
        const { prompt: normalizedPrompt, recovered } = recoverInlineOptions(userPrompt, options);
        const mergedOptions = { ...options, ...recovered };

        log("debug", "中间件输入调试", {
          optionImage: mergedOptions?.image ?? null,
          elements: summarizeElements((session as any)?.message?.elements || (session as any)?.elements),
          attachments: summarizeElements(
            (session as any)?.event?.message?.attachments ||
              (session as any)?.message?.attachments ||
              (session as any)?.attachments
          ),
          recoveredOptions: recovered,
        });

        if (mergedOptions?.list) {
          const presets = config.workflowPresets || [];
          const files = await listWorkflows(WORKFLOW_DIR);
          const presetNames = presets.map((p) => p.name).join(", ") || "（无）";
          const fileNames = files.map((f) => f.name).join(", ") || "（无）";
          return `工作流预设：${presetNames}\n工作流文件：${fileNames}`;
        }

        const workflowResolve = await resolveWorkflowText(config, mergedOptions?.noexpand ? "mossraw" : mergedOptions?.workflow, pluginLogger, WORKFLOW_DIR, comfyNode);
        const workflowText = workflowResolve.text;
        const promptJson = JSON.parse(workflowText);
        const hasPromptPlaceholder = workflowText.includes(PROMPT_PLACEHOLDER);
        const hasImagePlaceholder = /\{\{\s*image\s*\}\}/i.test(workflowText);
        const prefersBase64Image = workflowExpectsPureBase64(promptJson);

        log("info", "读取工作流 JSON 成功", {
          hasPlaceholder: hasPromptPlaceholder,
          hasImagePlaceholder,
          prefersBase64Image,
          source: workflowResolve.source,
          name: workflowResolve.name,
        });

        const finalUserPrompt = normalizedPrompt ?? "";

        const widthOpt = mergedOptions?.width ? Number(mergedOptions.width) : undefined;
        const heightOpt = mergedOptions?.height ? Number(mergedOptions.height) : undefined;
        const promptWithDims = applyOutputDimensions(promptJson, widthOpt, heightOpt, mergedOptions?.ratio, pluginLogger);
        const promptWithOverrides = applySamplerSteps(
          applyModelOverride(promptWithDims, mergedOptions?.model, config.modelAliases, pluginLogger),
          typeof mergedOptions?.steps === "number" ? mergedOptions.steps : undefined,
          pluginLogger
        );
        const promptWithLora = applyLoraOverride(promptWithOverrides, mergedOptions?.lora, config.loraAliases, pluginLogger);

        log("info", "开始执行工作流", { server: COMFYUI_SERVER, secure: IS_SECURE_CONNECTION });
        const extraPlaceholders: Record<string, any> = {};
        if (mergedOptions?.ratio) extraPlaceholders["ratio"] = mergedOptions.ratio;
        if (typeof mergedOptions?.steps === "number") extraPlaceholders["steps"] = mergedOptions.steps;
        if (mergedOptions?.vars) {
          try {
            const parsed = JSON.parse(mergedOptions.vars);
            if (parsed && typeof parsed === "object") {
              Object.assign(extraPlaceholders, parsed);
            }
          } catch (parseErr) {
            log("warn", "vars 解析失败，已忽略", { vars: mergedOptions.vars, error: (parseErr as any)?.message });
          }
        }

    const incomingImage = await resolveIncomingImage(ctx, session, mergedOptions?.image, IMAGE_CACHE_DIR, log);
    if (incomingImage) {
      const base64Raw = incomingImage.buffer.toString("base64");
      const padLen = (4 - (base64Raw.length % 4)) % 4;
      const base64 = padLen ? base64Raw + "=".repeat(padLen) : base64Raw;
      const dataUri = `data:image/png;base64,${base64}`;
      const imageValue = prefersBase64Image ? base64 : dataUri;

      const fillBase64Placeholders = () => {
        extraPlaceholders["image"] = imageValue; // 根据工作流需求决定是否带 data URI
        extraPlaceholders["imageBase64"] = base64;
        extraPlaceholders["image_base64"] = base64;
        extraPlaceholders["imageDataUri"] = dataUri;
        extraPlaceholders["image_data_uri"] = dataUri;
        extraPlaceholders["imageName"] = incomingImage.filename;
        extraPlaceholders["imageSubfolder"] = extraPlaceholders["imageSubfolder"] ?? "";
        extraPlaceholders["imageType"] = extraPlaceholders["imageType"] ?? "input";
      };

      const tryUploadFirst = IMAGE_UPLOAD_MODE === "image-first" && !prefersBase64Image;

      if (tryUploadFirst) {
        const upload = await comfyNode.uploadImage(incomingImage.buffer, incomingImage.filename, true, {
          timeoutMs: UPLOAD_TIMEOUT_MS,
          maxAttempts: UPLOAD_MAX_ATTEMPTS,
        });

        if (upload.success) {
          const uploadPayload = (upload.data as any) ?? {};
          const imageName = uploadPayload.name || uploadPayload.filename || incomingImage.filename;
          const imageSubfolder = uploadPayload.subfolder ?? "";
          const imageType = uploadPayload.type ?? "input";
          extraPlaceholders["image"] = imageName;
          extraPlaceholders["imageName"] = imageName;
          extraPlaceholders["imageSubfolder"] = imageSubfolder;
          extraPlaceholders["imageType"] = imageType;
          log("info", "图片已上传并写入占位符", { imageName, imageSubfolder, imageType });
        } else {
          const errMsg = (upload.error as any)?.message || upload.message || upload.error || "request timeout";
          fillBase64Placeholders();
          log("warn", "图片上传超时/失败，已回退为 base64 内联", {
            filename: incomingImage.filename,
            errMsg: truncate(String(errMsg), 180),
            base64Length: base64.length,
          });
        }
      } else {
        fillBase64Placeholders();
        log("info", "已按配置使用 base64 内联图片", {
          filename: incomingImage.filename,
          mode: IMAGE_UPLOAD_MODE,
          prefersBase64Image,
          base64Length: base64.length,
          head: base64.slice(0, 48),
        });
      }
    } else if (hasImagePlaceholder) {
      log("warn", "工作流包含 {{image}} 占位符但未接收到图片输入", { workflow: workflowResolve.name });
      return "当前工作流需要图片输入（包含占位符 {{image}}）。请附带图片或使用 `-i <url>` 再试一次。";
    }

        if (!finalUserPrompt && !incomingImage) {
          return "请提供提示词或图片中的任意一种输入";
        }

        const result: any = await comfyNode.executePromptWorkflow(promptWithLora, finalUserPrompt, { placeholders: extraPlaceholders });
        if (result.success) {
          const picked = pickOutputNode(result.outputs || {}, promptJson, pluginLogger);
          if (!picked) {
            const available = Object.keys(result.outputs || {});
            const statusError = (result.history as any)?.status?.error || (result.history as any)?.error;
            log("error", "未找到任何图片输出节点", { available, statusError });
            const hint = available.length ? `实际输出节点：${available.join(", ")}` : "执行结果中没有图片输出节点";
            const extra = statusError ? `可能的执行错误：${statusError}` : "";
            return `执行失败：未找到包含图片的输出节点。${hint}${extra ? "。" + extra : ""}`;
          }

          const outputNode = picked.node;
          const finalResult = outputNode.images.map((item: any) => ({
            filename: item.filename,
            buffer: item.buffer,
          }));
          const imageBuffer = finalResult[0].buffer as Buffer;
          const base64Image = imageBuffer.toString("base64");
          const dataUri = `data:image/png;base64,${base64Image}`;
          log("info", "工作流执行成功", { promptId: result.prompt_id });
          return <img src={dataUri} />;
        } else {
          const errMsg = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
          log("error", "工作流执行失败", { error: errMsg });
          return `执行失败：${errMsg || "未知错误"}`;
        }
      } catch (error) {
        const message = (error as any)?.message || String(error);
        log("error", "执行流程异常", { message, stack: (error as any)?.stack });
        return `执行失败：${message}`;
      }
    });
}
