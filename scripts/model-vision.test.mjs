import assert from 'node:assert/strict';
import test from 'node:test';
import { supportsVision } from '../out/model-vision.js';

test('visão reconhece o anúncio de modalidades do llama.cpp', () => {
  const model = { id: 'local.gguf', aliases: ['modelo-local'], architecture: { input_modalities: ['text', 'image', 'video'] } };
  assert.equal(supportsVision({ data: [model] }, 'local.gguf'), true);
  assert.equal(supportsVision({ data: [model] }, 'modelo-local'), true);
});

test('visão preserva capabilities e aceita modalidades explícitas', () => {
  assert.equal(supportsVision({ models: [{ name: 'v', capabilities: ['vision', 'tools'] }] }, 'v'), true);
  assert.equal(supportsVision({ data: [{ id: 'v', capabilities: { vision: true } }] }, 'v'), true);
  assert.equal(supportsVision({ data: [{ id: 'v', input_modalities: ['text', 'image'] }] }, 'v'), true);
});

test('outro modelo visual não habilita imagens para o modelo de texto selecionado', () => {
  const json = { data: [{ id: 'visual', capabilities: ['multimodal'] }, { id: 'texto', capabilities: ['tools'] }] };
  assert.equal(supportsVision(json, 'texto'), false);
  assert.equal(supportsVision(json, 'ausente'), false);
  assert.equal(supportsVision(json, ''), false);
});

test('metadados inválidos ou apenas nome visual não prometem suporte a imagem', () => {
  assert.equal(supportsVision(null, 'v'), false);
  assert.equal(supportsVision({ data: 'erro', models: {} }, 'v'), false);
  assert.equal(supportsVision({ data: [null, { id: 'vision-model', capabilities: 'vision' }] }, 'vision-model'), false);
  assert.equal(supportsVision({ data: [{ id: 'v', capabilities: { vision: 'false' }, architecture: { input_modalities: ['text'] } }] }, 'v'), false);
});
