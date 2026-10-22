// Um tool_call sem o resultado logo depois faz o servidor recusar a requisição INTEIRA, e o
// chat morria para sempre — toda mensagem nova voltava com o mesmo erro. Acontece quando o app
// fecha (ou o turno quebra) no meio das ferramentas: o histórico é salvo em vários momentos de
// uma execução, inclusive com a chamada já registrada e a resposta ainda por vir. Foi o caso
// de quem precisou fechar o app com um capture_page pendurado.

export const RESULTADO_PERDIDO = JSON.stringify({
  success: false, cancelled: true,
  error: 'No result: the app closed or the run broke before this tool returned. Check its effects before relying on them.'
});

type HistoricoReparavel = { messages: ChatMessage[]; podaManualAte?: number; podaAutoAte?: number };

// Cada chamada órfã ganha um resultado dizendo que não voltou, logo depois das que voltaram.
// Devolve quantos resultados entraram. As marcas de poda são ÍNDICES (ver truncaHistorico no
// renderer): o que estava depois do ponto de inserção anda junto.
export function reparaChamadasSemResposta(chat: HistoricoReparavel): number {
  let inseridos = 0;
  for (let i = 0; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.role !== 'assistant' || !m.tool_calls || !m.tool_calls.length) continue;
    let fim = i + 1;
    const respondidas = new Set<string>();
    while (fim < chat.messages.length && chat.messages[fim].role === 'tool') {
      respondidas.add(chat.messages[fim].tool_call_id);
      fim++;
    }
    const novas: ChatMessage[] = m.tool_calls
      .filter(tc => tc && tc.id && !respondidas.has(tc.id))
      .map(tc => ({ role: 'tool', tool_call_id: tc.id, name: (tc.function && tc.function.name) || 'unknown', content: RESULTADO_PERDIDO }));
    if (!novas.length) continue;
    chat.messages.splice(fim, 0, ...novas);
    if ((chat.podaManualAte || 0) >= fim) chat.podaManualAte += novas.length;
    if ((chat.podaAutoAte || 0) >= fim) chat.podaAutoAte += novas.length;
    inseridos += novas.length;
    i = fim + novas.length - 1;
  }
  return inseridos;
}
