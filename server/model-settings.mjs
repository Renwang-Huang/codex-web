import { RpcError } from "./rpc.mjs";

// Only model and reasoning effort may be overridden by the creation form.
// Provider credentials, permissions and all other configuration stay with Codex.
export function modelStartParams({ model, effort } = {}, catalog) {
  if (
    model != null &&
    (typeof model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/+\-]{0,159}$/.test(model))
  )
    throw new RpcError("模型名称无效", "INVALID");
  if (
    effort != null &&
    (typeof effort !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(effort))
  )
    throw new RpcError("推理强度无效", "INVALID");
  const effectiveModel =
    model ||
    catalog.defaults.model ||
    catalog.models.find((m) => m.isDefault)?.model;
  const entry = catalog.models.find((m) => m.model === effectiveModel);
  const supported =
    entry?.supportedReasoningEfforts ||
    catalog.models.flatMap((m) => m.supportedReasoningEfforts);
  if (effort && !supported.some((e) => e.reasoningEffort === effort))
    throw new RpcError("此模型不支持所选推理强度，请重新选择", "INVALID");
  const params = {};
  if (effectiveModel) {
    params.model = effectiveModel;
    params.allowProviderModelFallback = false;
  }
  const selectedEffort =
    effort ||
    (model && model !== catalog.defaults.model
      ? entry?.defaultReasoningEffort
      : catalog.defaults.effort || entry?.defaultReasoningEffort);
  if (selectedEffort)
    params.config = { model_reasoning_effort: selectedEffort };
  return params;
}
