import { useState, useEffect } from 'react';
import Terminal from './components/Terminal';
import Workspace from './components/Workspace';
import './App.css';

function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  // /terminal/<id> is a session detached into its own window.
  // Everything else is the tabbed workspace.
  const renderContent = () => {
    if (currentPath.startsWith('/terminal/')) {
      const agentId = currentPath.split('/terminal/')[1];
      return <Terminal agentId={agentId} onClose={() => window.close()} />;
    }
    return <Workspace />;
  };

  return (
    <div className="flex flex-col bg-slate-900 text-slate-50 font-sans h-screen w-screen overflow-hidden">
      {renderContent()}
    </div>
  );
}

export default App;
