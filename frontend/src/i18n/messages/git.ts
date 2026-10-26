/** Interface text of the Git tab. See ../messages.ts. Generic
 *  words of connection forms (Cancel, Save, Remove, ...) come
 *  from the Tasks tab's messages. */

export const gitEn = {
  'git.title': 'Git',
  'git.connections': 'Connections',
  'git.connectionsTitle': 'Connections to GitHub and Bitbucket',
  'git.refresh': 'Refresh pull requests and commits',
  'git.read': 'Accounts {ago}',
  'git.loadFailed': 'Could not load pull requests: {error}',
  'git.empty':
    'No Git account connected yet. Add a GitHub or Bitbucket Cloud account to see your pull requests and commits here.',
  'git.provider.github': 'GitHub',
  'git.provider.bitbucket': 'Bitbucket Cloud',

  // Sections
  'git.section.mine': 'My pull requests',
  'git.section.review': 'To review / assigned to me',
  'git.section.commits': 'My commits',
  'git.none.mine': 'No pull requests opened by you.',
  'git.none.review': 'Nothing is waiting for you.',
  'git.none.commits': 'No commits of yours in the last 14 days.',

  // Pull request badges
  'git.state.open': 'Open',
  'git.state.draft': 'Draft',
  'git.state.merged': 'Merged',
  'git.state.closed': 'Closed',
  'git.review.approved': 'Approved',
  'git.review.changes_requested': 'Changes requested',
  'git.review.pending': 'Review pending',
  'git.checks.success': 'CI passed',
  'git.checks.failure': 'CI failed',
  'git.checks.pending': 'CI running',
  'git.role.reviewer': 'Review requested',
  'git.role.assignee': 'Assigned',
  'git.by': 'by {author}',
  'git.reviewButton': 'Review PR',
  'git.reviewOf': 'Review {pr}',

  // Review panel
  'git.panel.label': 'Review of {pr}',
  'git.panel.open': 'Open pull request',
  'git.panel.loading': 'Loading the saved review…',
  'git.panel.running':
    'Claude is reviewing the changes. This can take up to two minutes.',
  'git.panel.start': 'Review PR',
  'git.panel.again': 'Review again',
  'git.panel.failed': 'The review failed: {error}',
  'git.panel.reviewed': 'Reviewed {when} with {model}',
  'git.panel.language': 'Language: {language}',
  'git.panel.summary': 'Summary',
  'git.panel.suggestions': 'Suggested comments',
  'git.panel.noSuggestions': 'No comments suggested.',
  'git.panel.nothingPosted':
    'Nothing is posted by itself: edit a comment if you want, then post it.',
  'git.panel.general': 'General comment',
  'git.panel.commentLabel': 'Comment on {where}',
  'git.panel.post': 'Post',
  'git.panel.posting': 'Posting…',
  'git.panel.posted': 'Posted',
  'git.panel.view': 'View',
  'git.panel.postedGeneral':
    'The line is not part of the changes, so it was posted as a general comment.',
  'git.panel.postFailed': 'Could not post: {error}',
  'git.verdict.approve': 'Looks good',
  'git.verdict.comment': 'Comments',
  'git.verdict.request_changes': 'Changes needed',

  // Connections
  'git.conn.title': 'Git connections',
  'git.conn.intro':
    'Each connection reads one GitHub or Bitbucket Cloud account with a personal token, every 2 minutes. Each connection is yours only.',
  'git.conn.provider': 'Service',
  'git.conn.namePlaceholder': 'e.g. GitHub work',
  'git.conn.email': 'Atlassian account email',
  'git.conn.workspaces': 'Workspaces',
  'git.conn.workspacesHelp':
    'Workspace slugs separated by commas, as in bitbucket.org/<workspace>.',
  'git.conn.token.github': 'Personal access token',
  'git.conn.token.bitbucket': 'API token',
  'git.conn.help.github':
    'A classic token with the repo and read:user scopes, or a fine-grained token with Pull requests (read and write), Contents (read) and Metadata (read).',
  'git.conn.help.bitbucket':
    'An Atlassian API token with the scopes read:user, read:workspace, read:repository, read:pullrequest and write:pullrequest (all for Bitbucket).',
  'git.conn.createToken': 'Create one',
  'git.conn.refreshTitle': 'Read pull requests and commits again',
  'git.conn.count': '{prs} pull requests · {commits} commits',
  'git.conn.confirmRemove':
    'Remove this connection? Nothing changes on GitHub or Bitbucket.',
};

export const gitPt: Record<keyof typeof gitEn, string> = {
  'git.title': 'Git',
  'git.connections': 'Conexões',
  'git.connectionsTitle': 'Conexões com GitHub e Bitbucket',
  'git.refresh': 'Atualizar PRs e commits',
  'git.read': 'Contas: {ago}',
  'git.loadFailed': 'Não foi possível carregar os PRs: {error}',
  'git.empty':
    'Nenhuma conta Git conectada ainda. Adicione uma conta do GitHub ou do Bitbucket Cloud para ver aqui seus PRs e commits.',
  'git.provider.github': 'GitHub',
  'git.provider.bitbucket': 'Bitbucket Cloud',

  'git.section.mine': 'Meus PRs',
  'git.section.review': 'Para revisar / atribuídos a mim',
  'git.section.commits': 'Meus commits',
  'git.none.mine': 'Nenhum PR aberto por você.',
  'git.none.review': 'Nada esperando por você.',
  'git.none.commits': 'Nenhum commit seu nos últimos 14 dias.',

  'git.state.open': 'Aberto',
  'git.state.draft': 'Rascunho',
  'git.state.merged': 'Mesclado',
  'git.state.closed': 'Fechado',
  'git.review.approved': 'Aprovado',
  'git.review.changes_requested': 'Mudanças pedidas',
  'git.review.pending': 'Review pendente',
  'git.checks.success': 'CI ok',
  'git.checks.failure': 'CI falhou',
  'git.checks.pending': 'CI rodando',
  'git.role.reviewer': 'Review pedido',
  'git.role.assignee': 'Atribuído',
  'git.by': 'por {author}',
  'git.reviewButton': 'Revisar PR',
  'git.reviewOf': 'Revisar {pr}',

  'git.panel.label': 'Review de {pr}',
  'git.panel.open': 'Abrir PR',
  'git.panel.loading': 'Carregando o review salvo…',
  'git.panel.running':
    'O Claude está revisando as mudanças. Isso pode levar até dois minutos.',
  'git.panel.start': 'Revisar PR',
  'git.panel.again': 'Revisar de novo',
  'git.panel.failed': 'O review falhou: {error}',
  'git.panel.reviewed': 'Revisado {when} com {model}',
  'git.panel.language': 'Idioma: {language}',
  'git.panel.summary': 'Resumo',
  'git.panel.suggestions': 'Comentários sugeridos',
  'git.panel.noSuggestions': 'Nenhum comentário sugerido.',
  'git.panel.nothingPosted':
    'Nada é postado sozinho: edite o comentário se quiser e depois poste.',
  'git.panel.general': 'Comentário geral',
  'git.panel.commentLabel': 'Comentário em {where}',
  'git.panel.post': 'Postar',
  'git.panel.posting': 'Postando…',
  'git.panel.posted': 'Postado',
  'git.panel.view': 'Ver',
  'git.panel.postedGeneral':
    'A linha não faz parte das mudanças, então foi postado como comentário geral.',
  'git.panel.postFailed': 'Não foi possível postar: {error}',
  'git.verdict.approve': 'Parece bom',
  'git.verdict.comment': 'Comentários',
  'git.verdict.request_changes': 'Precisa de mudanças',

  'git.conn.title': 'Conexões Git',
  'git.conn.intro':
    'Cada conexão lê uma conta do GitHub ou do Bitbucket Cloud com um token pessoal, a cada 2 minutos. Cada conexão é só sua.',
  'git.conn.provider': 'Serviço',
  'git.conn.namePlaceholder': 'ex.: GitHub trabalho',
  'git.conn.email': 'E-mail da conta Atlassian',
  'git.conn.workspaces': 'Workspaces',
  'git.conn.workspacesHelp':
    'Slugs dos workspaces separados por vírgula, como em bitbucket.org/<workspace>.',
  'git.conn.token.github': 'Token de acesso pessoal',
  'git.conn.token.bitbucket': 'Token de API',
  'git.conn.help.github':
    'Um token clássico com os escopos repo e read:user, ou um token fine-grained com Pull requests (leitura e escrita), Contents (leitura) e Metadata (leitura).',
  'git.conn.help.bitbucket':
    'Um token de API da Atlassian com os escopos read:user, read:workspace, read:repository, read:pullrequest e write:pullrequest (todos do Bitbucket).',
  'git.conn.createToken': 'Criar um',
  'git.conn.refreshTitle': 'Ler PRs e commits de novo',
  'git.conn.count': '{prs} PRs · {commits} commits',
  'git.conn.confirmRemove':
    'Remover esta conexão? Nada muda no GitHub ou no Bitbucket.',
};
