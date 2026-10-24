/** Interface text of the terminal screens. See ../messages.ts. */

export const terminalEn = {
  // Header
  'terminal.agent': 'Agent',
  'terminal.attach': 'Attach {label}',
  'terminal.open': 'Open {label}',
  'terminal.attachTitle': 'Attach to existing {label} session',
  'terminal.openTitle': 'Open new {label} session',
  'terminal.detach': 'Detach',
  'terminal.detachTitle': 'Move this session to its own window',
  'terminal.closeTab': 'Close Tab',
  'terminal.closeWindow': 'Close Window',

  // File drop
  'terminal.dropFiles': 'Drop files to send them to this session',
  'terminal.dismiss': 'Click to dismiss',
  'terminal.noFile':
    'The browser handed over no file. Drag it from a file manager.',
  'terminal.sending': 'Sending {name}…',
  'terminal.files': '{count} files',
  'terminal.uploadTooLarge': 'larger than {mb} MB.',
  'terminal.uploadStatus': 'the server answered {status}.',
  'terminal.uploadUnreadable':
    'could not be read or sent. Folders are not supported.',

  // Screen as text
  'terminal.holdToSelect': 'Press and hold to select',
  'terminal.copyAll': 'Copy all',
  'terminal.backToTerminal': 'Back to the terminal',

  // Ended session
  'terminal.resuming': 'Resuming session...',
  'terminal.ended': 'This session has ended.',
  'terminal.resumeFailed': 'Failed to resume — the host may be offline.',
  'terminal.resume': 'Resume',
  'terminal.close': 'Close',

  // Touch input bar
  'terminal.keyUp': 'Up',
  'terminal.keyDown': 'Down',
  'terminal.keyLeft': 'Left',
  'terminal.keyRight': 'Right',
  'terminal.keySlash': 'Slash',
  'terminal.selectText': 'Select text',
  'terminal.selectTextTitle': 'Show the screen as text to select and copy',
  'terminal.messagePlaceholder': 'Type a message…',
  'terminal.messageLabel': 'Message to the session',
  'terminal.send': 'Send',
  'terminal.pressEnter': 'Press Enter',
};

export const terminalPt: Record<keyof typeof terminalEn, string> = {
  // Header
  'terminal.agent': 'Agente',
  'terminal.attach': 'Conectar {label}',
  'terminal.open': 'Abrir {label}',
  'terminal.attachTitle': 'Conectar à sessão existente de {label}',
  'terminal.openTitle': 'Abrir nova sessão de {label}',
  'terminal.detach': 'Abrir em janela',
  'terminal.detachTitle': 'Mover esta sessão para uma janela própria',
  'terminal.closeTab': 'Fechar aba',
  'terminal.closeWindow': 'Fechar janela',

  // File drop
  'terminal.dropFiles': 'Solte arquivos para enviá-los a esta sessão',
  'terminal.dismiss': 'Clique para dispensar',
  'terminal.noFile':
    'O navegador não entregou nenhum arquivo. Arraste-o de um gerenciador de arquivos.',
  'terminal.sending': 'Enviando {name}…',
  'terminal.files': '{count} arquivos',
  'terminal.uploadTooLarge': 'maior que {mb} MB.',
  'terminal.uploadStatus': 'o servidor respondeu {status}.',
  'terminal.uploadUnreadable':
    'não pôde ser lido ou enviado. Pastas não são suportadas.',

  // Screen as text
  'terminal.holdToSelect': 'Toque e segure para selecionar',
  'terminal.copyAll': 'Copiar tudo',
  'terminal.backToTerminal': 'Voltar ao terminal',

  // Ended session
  'terminal.resuming': 'Retomando sessão...',
  'terminal.ended': 'Esta sessão terminou.',
  'terminal.resumeFailed': 'Falha ao retomar — o host pode estar offline.',
  'terminal.resume': 'Retomar',
  'terminal.close': 'Fechar',

  // Touch input bar
  'terminal.keyUp': 'Cima',
  'terminal.keyDown': 'Baixo',
  'terminal.keyLeft': 'Esquerda',
  'terminal.keyRight': 'Direita',
  'terminal.keySlash': 'Barra',
  'terminal.selectText': 'Selecionar texto',
  'terminal.selectTextTitle':
    'Mostrar a tela como texto para selecionar e copiar',
  'terminal.messagePlaceholder': 'Digite uma mensagem…',
  'terminal.messageLabel': 'Mensagem para a sessão',
  'terminal.send': 'Enviar',
  'terminal.pressEnter': 'Pressionar Enter',
};
