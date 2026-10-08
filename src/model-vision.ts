// SPDX-License-Identifier: Apache-2.0

export function supportsVision(json: any, modelId: string): boolean {
  if (!modelId) return false;
  const models = [
    ...(Array.isArray(json?.models) ? json.models : []),
    ...(Array.isArray(json?.data) ? json.data : [])
  ];
  return models.filter(m => m && [m.id, m.name, m.model,
    ...(Array.isArray(m.aliases) ? m.aliases : [])].includes(modelId)).some(m => {
    const caps = m.capabilities;
    if (Array.isArray(caps) && caps.some(c => /^(multimodal|vision|image)$/i.test(String(c)))) return true;
    if (caps && typeof caps === 'object' && ['multimodal', 'vision', 'image'].some(k => caps[k] === true)) return true;
    const modalities = m.architecture?.input_modalities ?? m.input_modalities ?? m.supported_input_modalities;
    return Array.isArray(modalities) && modalities.some(c => String(c).toLowerCase() === 'image');
  });
}
