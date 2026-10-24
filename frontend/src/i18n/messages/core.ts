/** Interface text of the workspace shell and the dashboard
 *  header. See ../messages.ts. */

export const coreEn = {
  // Settings
  'settings.title': 'Settings',
  'settings.theme': 'Theme',
  'settings.language': 'Language',
  'settings.session': 'Session',
  'settings.renameSession': 'Rename session',

  // Workspace tabs
  'tabs.sessions': 'Sessions',
  'tabs.dashboard': 'Dashboard',
  'tabs.dashboardShortcut': 'Dashboard (Alt+1)',
  'tabs.tasks': 'Tasks',
  'tabs.shortcut': '(Alt+{n})',
  'tabs.close': 'Close tab {label}',
  'tabs.closeTitle': 'Close tab',
  'tabs.closeSessionTitle': 'Close tab (the session keeps running)',
  'tabs.actions': 'Tab actions',
  'tabs.sessionName': 'Session name',
  'tabs.sessionNamePlaceholder': 'Name (blank for default)',
  'tabs.sessionFallback': 'Session',
  'tabs.splitClose': 'Close split',
  'tabs.splitRow': 'Split side by side',
  'tabs.splitCol': 'Split top and bottom',
  'tabs.splitNeedsTwo': 'Open two session tabs to split the view',
  'tabs.notifyOn': 'Notifications are on',
  'tabs.notifyBlocked': 'Notifications are blocked in the browser settings',
  'tabs.notifyTurnOn': 'Turn on notifications',
  'tabs.notifyOnTitle':
    'Notifications are on: sessions that need attention notify you while this page is in the background',
  'tabs.notifyBlockedTitle':
    'Notifications are blocked in the browser settings for this site',
  'tabs.notifyTurnOnTitle': 'Notify me when a session needs attention',

  // Attention marks
  'attention.ended': 'Session ended',
  'attention.permission': 'Waiting for permission',
  'attention.done': 'Finished working',

  // Dashboard
  'dashboard.title': 'Agent Dashboard',
  'dashboard.available': '{version} available',
  'dashboard.latest': 'latest: {version}',
  'dashboard.hostsShort': 'Hosts',
  'dashboard.hosts': 'Registered Hosts',
  'dashboard.agentsShort': 'Agents',
  'dashboard.agents': 'Active Agents',
  'dashboard.section': 'Registered Hosts & Active Sessions',
  'dashboard.live': 'Live telemetry from remote daemons',
  'dashboard.loading': 'Loading dashboard…',
  'dashboard.error': 'Error:',
  'dashboard.fetchFailed': 'Failed to fetch dashboard data. Are you logged in?',
  'dashboard.login': 'Login via OIDC',
  'dashboard.spawnFailed': 'Failed to spawn agent. Check console for details.',
  'dashboard.confirmStop': 'Are you sure you want to stop this agent?',
  'dashboard.confirmDeleteHost':
    'Are you sure you want to delete this host? All its agent sessions will also be removed.',
  'dashboard.deleteHostFailed':
    'Failed to delete host. Check console for details.',

  // Error screens
  'error.tabTitle': 'This tab hit an error',
  'error.appTitle': 'The dashboard hit an error',
  'error.hint':
    'Copy the log below and paste it into an AI chat or an issue to debug it.',
  'error.log': 'Error log',
  'error.copy': 'Copy log',
  'error.copied': 'Copied!',
  'error.retry': 'Try again',
  'error.reload': 'Reload page',
};

export const corePt: Record<keyof typeof coreEn, string> = {
  'settings.title': 'Configurações',
  'settings.theme': 'Tema',
  'settings.language': 'Idioma',
  'settings.session': 'Sessão',
  'settings.renameSession': 'Renomear sessão',

  'tabs.sessions': 'Sessões',
  'tabs.dashboard': 'Painel',
  'tabs.dashboardShortcut': 'Painel (Alt+1)',
  'tabs.tasks': 'Tarefas',
  'tabs.shortcut': '(Alt+{n})',
  'tabs.close': 'Fechar aba {label}',
  'tabs.closeTitle': 'Fechar aba',
  'tabs.closeSessionTitle': 'Fechar aba (a sessão continua rodando)',
  'tabs.actions': 'Ações da aba',
  'tabs.sessionName': 'Nome da sessão',
  'tabs.sessionNamePlaceholder': 'Nome (vazio para o padrão)',
  'tabs.sessionFallback': 'Sessão',
  'tabs.splitClose': 'Fechar divisão',
  'tabs.splitRow': 'Dividir lado a lado',
  'tabs.splitCol': 'Dividir em cima e embaixo',
  'tabs.splitNeedsTwo': 'Abra duas abas de sessão para dividir a tela',
  'tabs.notifyOn': 'Notificações ativadas',
  'tabs.notifyBlocked':
    'Notificações bloqueadas nas configurações do navegador',
  'tabs.notifyTurnOn': 'Ativar notificações',
  'tabs.notifyOnTitle':
    'Notificações ativadas: sessões que precisam de atenção avisam você enquanto esta página está em segundo plano',
  'tabs.notifyBlockedTitle':
    'Notificações bloqueadas nas configurações do navegador para este site',
  'tabs.notifyTurnOnTitle': 'Avise-me quando uma sessão precisar de atenção',

  'attention.ended': 'Sessão encerrada',
  'attention.permission': 'Aguardando permissão',
  'attention.done': 'Terminou o trabalho',

  'dashboard.title': 'Agent Dashboard',
  'dashboard.available': '{version} disponível',
  'dashboard.latest': 'mais recente: {version}',
  'dashboard.hostsShort': 'Hosts',
  'dashboard.hosts': 'Hosts registrados',
  'dashboard.agentsShort': 'Agentes',
  'dashboard.agents': 'Agentes ativos',
  'dashboard.section': 'Hosts registrados e sessões ativas',
  'dashboard.live': 'Telemetria ao vivo dos daemons remotos',
  'dashboard.loading': 'Carregando o painel…',
  'dashboard.error': 'Erro:',
  'dashboard.fetchFailed':
    'Não foi possível carregar os dados do painel. Você está logado?',
  'dashboard.login': 'Entrar com OIDC',
  'dashboard.spawnFailed':
    'Não foi possível iniciar o agente. Veja o console para detalhes.',
  'dashboard.confirmStop': 'Tem certeza de que quer parar este agente?',
  'dashboard.confirmDeleteHost':
    'Tem certeza de que quer excluir este host? Todas as sessões de agente dele também serão removidas.',
  'dashboard.deleteHostFailed':
    'Não foi possível excluir o host. Veja o console para detalhes.',

  // Error screens
  'error.tabTitle': 'Esta aba encontrou um erro',
  'error.appTitle': 'O painel encontrou um erro',
  'error.hint':
    'Copie o log abaixo e cole numa conversa com uma IA ou numa issue para depurar.',
  'error.log': 'Log do erro',
  'error.copy': 'Copiar log',
  'error.copied': 'Copiado!',
  'error.retry': 'Tentar de novo',
  'error.reload': 'Recarregar página',
};
