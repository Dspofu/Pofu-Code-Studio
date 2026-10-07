export class RemoteHistory {
  private messages = new WeakMap<object, { id: string; content: unknown; calls: string }>();
  private chats = new WeakMap<object, { signature: string; revision: string }>();
  reference(message: ChatMessage) {
    const calls = JSON.stringify(message.tool_calls || []), previous = this.messages.get(message);
    if (previous && previous.content === message.content && previous.calls === calls) return previous.id;
    const id = crypto.randomUUID(); this.messages.set(message, { id, content: message.content, calls }); return id;
  }
  revision(chat: Chat) {
    const signature = chat.messages.map(message => this.reference(message)).join(','), previous = this.chats.get(chat);
    if (previous?.signature === signature) return previous.revision;
    const revision = crypto.randomUUID(); this.chats.set(chat, { signature, revision }); return revision;
  }
  check(chat: Chat, revision: string) { if (!revision || revision !== this.revision(chat)) throw new Error('A conversa mudou. Atualize e confira antes de tentar novamente.'); }
  locate(chat: Chat, messageId: string, revision: string) {
    this.check(chat, revision);
    const index = chat.messages.findIndex(message => this.reference(message) === messageId), message = chat.messages[index];
    if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Mensagem não encontrada ou não editável.');
    return { index, message };
  }
}
