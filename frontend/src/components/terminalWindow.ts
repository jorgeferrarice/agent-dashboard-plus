/** Open (or focus) a terminal popup window for the given agent. */
export function openTerminalWindow(agentId: string) {
  const width = 1024;
  const height = 768;
  const left = (window.screen.width - width) / 2;
  const top = (window.screen.height - height) / 2;
  window.open(
    `/terminal/${agentId}`,
    `agent_${agentId}`,
    `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,personalbar=no`,
  );
}
