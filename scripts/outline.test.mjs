import test from 'node:test';
import assert from 'node:assert/strict';
import { extraiDefinicoes, formataEstrutura, suportaEstrutura } from '../out/outline.js';

const nomes = (texto, arquivo) => extraiDefinicoes(texto, arquivo).defs.map(d => `${d.line}${d.nested ? '>' : ' '}${d.text}`);

test('TypeScript: classes, métodos, funções, arrow e tipos — sem if/for/chamadas', () => {
  const src = [
    'export class Loja<T> extends Base {',            // 1
    '  private itens = [];',                            // 2
    '  async adiciona(item: T): Promise<void> {',       // 3
    '    if (item) {',                                  // 4
    '      for (const x of this.itens) {',              // 5
    '        registra(function () {',                   // 6
    '        });',
    '      }',
    '    }',
    '  }',
    '}',
    'export function soma(a: number, b: number) {',     // 12
    'const dobra = (n) => n * 2;',                      // 13
    'export const busca = async (q: string): Promise<X> => {', // 14
    'export interface Opcoes {',                        // 15
    'type Id = string | number;',                       // 16
    '/* function comentada() {',                        // 17
    '*/',
    'describe("x", () => {',                            // 19
  ].join('\n');
  assert.deepEqual(nomes(src, 'a.ts'), [
    '1 export class Loja<T> extends Base', '3>async adiciona(item: T): Promise<void>',
    '12 export function soma(a: number, b: number)', '13 const dobra = (n) =>',
    '14 export const busca = async (q: string): Promise<X> =>', '15 export interface Opcoes', '16 type Id = string | number;'
  ]);
});

test('Python, Go, Rust e C#', () => {
  assert.deepEqual(nomes('class A:\n    def m(self):\n        pass\nasync def f(x):\n', 'x.py'), ['1 class A:', '2>def m(self):', '4 async def f(x):']);
  assert.deepEqual(nomes('type S struct {\nfunc (s *S) Run() error {\nfunc main() {', 'm.go'), ['1 type S struct', '2 func (s *S) Run() error', '3 func main()']);
  assert.deepEqual(nomes('pub struct P;\nimpl P {\n    pub async fn novo() -> Self {', 'l.rs'), ['1 pub struct P;', '2 impl P', '3>pub async fn novo() -> Self']);
  assert.deepEqual(nomes('public class Svc {\n    public async Task<int> Get(int id)\n    {', 's.cs'), ['1 public class Svc', '2>public async Task<int> Get(int id)']);
});

test('extensão sem regras, formato agrupado e limite por arquivo', () => {
  assert.equal(suportaEstrutura('README.md'), false); assert.equal(suportaEstrutura('src/App.TSX'), true);
  const r = extraiDefinicoes(Array.from({ length: 10 }, (_, i) => `function f${i}() {`).join('\n'), 'x.js', 3);
  assert.equal(r.defs.length, 3); assert.equal(r.capped, true);
  assert.equal(formataEstrutura([{ file: 'src/a.ts', lines: 20, defs: [{ line: 3, nested: false, text: 'function a()' }, { line: 5, nested: true, text: 'b()' }] }, { file: 'src/vazio.ts', lines: 2, defs: [] }]),
    'src/a.ts (20 lines)\n  3: function a()\n    5: b()\n[no definitions: src/vazio.ts]');
});
