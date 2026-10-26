/** Interface text of a session's chat view. See ../messages.ts. */

export const chatEn = {
  // Switching views
  'chat.viewLabel': 'View',
  'chat.viewChat': 'Chat',
  'chat.viewTerminal': 'Terminal',

  // Conversation
  'chat.empty': 'Waiting for the first message…',
  'chat.emptyHint':
    'Write below to start. The session keeps running in its terminal.',
  'chat.working': 'Claude is working…',
  'chat.compacted': 'Conversation compacted',
  'chat.interrupted': 'Interrupted',
  'chat.task': 'Background task',

  // Tool calls
  'chat.input': 'Input',
  'chat.result': 'Result',
  'chat.toolError': 'Error',
  'chat.toolPending': 'No result yet',
  'chat.truncated': 'Cut short: the whole output is in the terminal.',

  // Groups of tool calls
  'chat.groupRunningOne': '{count} command running',
  'chat.groupRunning': '{count} commands running',
  'chat.groupDoneOne': '{count} done',
  'chat.groupDone': '{count} done',
  'chat.groupFailedOne': '{count} failed',
  'chat.groupFailed': '{count} failed',
  'chat.groupCommandsOne': '{count} command',
  'chat.groupCommands': '{count} commands',

  // Menus on the session's screen
  'chat.menuTitle': 'Claude is waiting for your answer',
  'chat.cancelMenu': 'Cancel (Esc)',
  'chat.typeBelow': 'then write the answer below',

  // Permission
  'chat.permission': 'Claude asks for permission',
  'chat.seeTerminal': 'See in the terminal',

  // Media
  'chat.download': 'Download',
  'chat.expand': 'Show over the whole window',
  'chat.close': 'Close',
  'chat.loading': 'Loading…',
  'chat.openPage': 'Open page',
  'chat.openArtifact': 'Open artifact',
  'chat.pasted': 'Pasted text',
  'chat.mediaError': 'Could not load {src}',
  'chat.loadExternal': 'Load media from {host}',

  // Composer
  'chat.placeholder': 'Message Claude…',
  'chat.messageLabel': 'Message to Claude',
  'chat.send': 'Send',
  'chat.attach': 'Attach files',
  'chat.stop': 'Stop',
  'chat.stopTitle': 'Press Esc in the session',
  'chat.dropFiles': 'Drop files to attach them to the message',
};

export const chatPt: Record<keyof typeof chatEn, string> = {
  // Switching views
  'chat.viewLabel': 'Visão',
  'chat.viewChat': 'Chat',
  'chat.viewTerminal': 'Terminal',

  // Conversation
  'chat.empty': 'Aguardando a primeira mensagem…',
  'chat.emptyHint':
    'Escreva abaixo para começar. A sessão continua rodando no terminal.',
  'chat.working': 'Claude está trabalhando…',
  'chat.compacted': 'Conversa compactada',
  'chat.interrupted': 'Interrompido',
  'chat.task': 'Tarefa em segundo plano',

  // Tool calls
  'chat.input': 'Entrada',
  'chat.result': 'Resultado',
  'chat.toolError': 'Erro',
  'chat.toolPending': 'Ainda sem resultado',
  'chat.truncated': 'Cortado: a saída inteira está no terminal.',

  // Groups of tool calls
  'chat.groupRunningOne': '{count} comando rodando',
  'chat.groupRunning': '{count} comandos rodando',
  'chat.groupDoneOne': '{count} concluído',
  'chat.groupDone': '{count} concluídos',
  'chat.groupFailedOne': '{count} com erro',
  'chat.groupFailed': '{count} com erro',
  'chat.groupCommandsOne': '{count} comando',
  'chat.groupCommands': '{count} comandos',

  // Menus on the session's screen
  'chat.menuTitle': 'O Claude espera sua resposta',
  'chat.cancelMenu': 'Cancelar (Esc)',
  'chat.typeBelow': 'depois escreva a resposta abaixo',

  // Permission
  'chat.permission': 'O Claude pede permissão',
  'chat.seeTerminal': 'Ver no terminal',

  // Media
  'chat.download': 'Baixar',
  'chat.expand': 'Ver na janela inteira',
  'chat.close': 'Fechar',
  'chat.loading': 'Carregando…',
  'chat.openPage': 'Abrir página',
  'chat.openArtifact': 'Abrir artefato',
  'chat.pasted': 'Texto colado',
  'chat.mediaError': 'Não foi possível carregar {src}',
  'chat.loadExternal': 'Carregar mídia de {host}',

  // Composer
  'chat.placeholder': 'Mensagem para o Claude…',
  'chat.messageLabel': 'Mensagem para o Claude',
  'chat.send': 'Enviar',
  'chat.attach': 'Anexar arquivos',
  'chat.stop': 'Parar',
  'chat.stopTitle': 'Pressiona Esc na sessão',
  'chat.dropFiles': 'Solte arquivos para anexá-los à mensagem',
};
