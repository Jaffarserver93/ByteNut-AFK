import { useEffect, useState } from "react";
import { 
  useGetBotStatus, getGetBotStatusQueryKey,
  useGetBotScreenshot, getGetBotScreenshotQueryKey,
  useGetBotLogs, getGetBotLogsQueryKey,
  useStartBot, useStopBot, useClearBotLogs
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Play, Square, Terminal, Image as ImageIcon, Activity, Clock, RefreshCw, Trash2, CheckCircle2, AlertTriangle, AlertCircle, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Dashboard() {
  const queryClient = useQueryClient();

  const { data: status } = useGetBotStatus(undefined, { 
    query: { refetchInterval: 2000, queryKey: getGetBotStatusQueryKey() } 
  });
  
  const { data: screenshot } = useGetBotScreenshot(undefined, { 
    query: { refetchInterval: 5000, queryKey: getGetBotScreenshotQueryKey() } 
  });
  
  const { data: logs } = useGetBotLogs(undefined, { 
    query: { refetchInterval: 3000, queryKey: getGetBotLogsQueryKey() } 
  });

  const startBot = useStartBot();
  const stopBot = useStopBot();
  const clearLogs = useClearBotLogs();

  const handleStart = () => {
    startBot.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handleStop = () => {
    stopBot.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  const handleClearLogs = () => {
    clearLogs.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotLogsQueryKey() });
      }
    });
  };

  // Uptime counter
  const [uptimeDisplay, setUptimeDisplay] = useState("00:00:00");
  const uptimeSeconds = status?.uptimeSeconds || 0;
  
  useEffect(() => {
    let currentSeconds = uptimeSeconds;
    
    const formatTime = (totalSeconds: number) => {
      const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
      const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
      const s = (totalSeconds % 60).toString().padStart(2, '0');
      return `${h}:${m}:${s}`;
    };

    setUptimeDisplay(formatTime(currentSeconds));

    if (status?.running) {
      const interval = setInterval(() => {
        currentSeconds++;
        setUptimeDisplay(formatTime(currentSeconds));
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [uptimeSeconds, status?.running]);

  const getStatusColor = (state?: string) => {
    switch (state) {
      case 'idle': return 'bg-muted text-muted-foreground border-muted';
      case 'logging_in': return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
      case 'navigating': return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50';
      case 'active': return 'bg-green-500/20 text-green-400 border-green-500/50';
      case 'error': return 'bg-destructive/20 text-destructive border-destructive/50';
      case 'stopped': return 'bg-muted text-muted-foreground border-muted';
      default: return 'bg-muted text-muted-foreground border-muted';
    }
  };

  const getLogIcon = (level: string) => {
    switch (level) {
      case 'info': return <Info className="h-4 w-4 text-blue-400" />;
      case 'success': return <CheckCircle2 className="h-4 w-4 text-green-400" />;
      case 'warn': return <AlertTriangle className="h-4 w-4 text-yellow-400" />;
      case 'error': return <AlertCircle className="h-4 w-4 text-destructive" />;
      default: return <Info className="h-4 w-4 text-blue-400" />;
    }
  };

  const getLogColor = (level: string) => {
    switch (level) {
      case 'info': return 'text-blue-400';
      case 'success': return 'text-green-400';
      case 'warn': return 'text-yellow-400';
      case 'error': return 'text-destructive';
      default: return 'text-blue-400';
    }
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground p-4 md:p-8 relative overflow-hidden flex flex-col">
      {/* Background glowing orb */}
      <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[80%] h-[50vh] rounded-full bg-primary/5 blur-[120px] pointer-events-none" />
      
      <div className="max-w-6xl mx-auto w-full z-10 space-y-6 flex-1 flex flex-col">
        {/* Header */}
        <header className="flex flex-col items-center justify-center py-6 text-center space-y-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-[0_0_20px_rgba(var(--primary),0.3)]">
              <Activity className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">ByteNut AFK Bot</h1>
          </div>
          <p className="text-muted-foreground bg-clip-text text-transparent bg-gradient-to-r from-muted-foreground to-primary/80 font-medium">
            Persistent browser automation & monitoring
          </p>
        </header>

        {/* Top Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-card/40 backdrop-blur-md border-white/5 shadow-xl md:col-span-2 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
            <CardContent className="p-6 flex flex-col sm:flex-row items-center justify-between gap-4 h-full">
              <div className="flex flex-col space-y-1 text-center sm:text-left">
                <span className="text-sm font-medium text-muted-foreground flex items-center gap-2 justify-center sm:justify-start">
                  <Activity className="h-4 w-4" /> System Status
                </span>
                <div className="flex items-center gap-3 mt-1 justify-center sm:justify-start">
                  <Badge variant="outline" className={`px-3 py-1 text-sm font-medium transition-colors duration-300 ${getStatusColor(status?.state)}`}>
                    {status?.state ? status.state.replace('_', ' ').toUpperCase() : 'UNKNOWN'}
                  </Badge>
                  {status?.state === 'active' && (
                    <span className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                    </span>
                  )}
                </div>
              </div>

              <div className="flex gap-3">
                <Button 
                  onClick={handleStart} 
                  disabled={status?.running || startBot.isPending}
                  className="bg-primary/20 hover:bg-primary/30 text-primary border border-primary/50 hover:shadow-[0_0_15px_rgba(var(--primary),0.4)] transition-all duration-300"
                >
                  <Play className="mr-2 h-4 w-4" /> Start Bot
                </Button>
                <Button 
                  onClick={handleStop}
                  disabled={!status?.running || stopBot.isPending}
                  variant="destructive"
                  className="bg-destructive/20 hover:bg-destructive/30 text-destructive border border-destructive/50 hover:shadow-[0_0_15px_rgba(var(--destructive),0.4)] transition-all duration-300"
                >
                  <Square className="mr-2 h-4 w-4" /> Stop Bot
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/40 backdrop-blur-md border-white/5 shadow-xl">
            <CardContent className="p-6 flex flex-col justify-center h-full">
              <span className="text-sm font-medium text-muted-foreground flex items-center gap-2 mb-2">
                <Clock className="h-4 w-4" /> Uptime
              </span>
              <span className="text-3xl font-mono tracking-tight font-bold text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]">
                {uptimeDisplay}
              </span>
            </CardContent>
          </Card>

          <Card className="bg-card/40 backdrop-blur-md border-white/5 shadow-xl">
            <CardContent className="p-6 flex flex-col justify-center h-full">
              <span className="text-sm font-medium text-muted-foreground flex items-center gap-2 mb-2">
                <RefreshCw className="h-4 w-4" /> Reloads
              </span>
              <div className="flex flex-col">
                <span className="text-3xl font-bold text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]">
                  {status?.reloadCount || 0}
                </span>
                {status?.lastReloadAt && (
                  <span className="text-xs text-muted-foreground mt-1">
                    Last: {new Date(status.lastReloadAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-[400px]">
          {/* Live Preview Panel */}
          <Card className="bg-card/40 backdrop-blur-md border-white/5 shadow-xl flex flex-col overflow-hidden">
            <CardHeader className="border-b border-white/5 py-4 px-6 bg-black/20 flex flex-row items-center justify-between">
              <CardTitle className="text-lg font-medium flex items-center gap-2 text-white">
                <ImageIcon className="h-5 w-5 text-primary" /> Live Preview
              </CardTitle>
              {screenshot?.capturedAt && (
                <span className="text-xs text-muted-foreground">
                  Updated: {new Date(screenshot.capturedAt).toLocaleTimeString()}
                </span>
              )}
            </CardHeader>
            <CardContent className="p-0 flex-1 relative bg-black/40 flex items-center justify-center min-h-[300px]">
              {screenshot?.data ? (
                <img 
                  src={`data:image/png;base64,${screenshot.data}`} 
                  alt="Bot Browser View" 
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <ImageIcon className="h-12 w-12 mb-4 opacity-20" />
                  <p>Bot not running</p>
                  <p className="text-sm opacity-70">Start the bot to see the live preview</p>
                </div>
              )}
              
              {/* Overlay gradient for depth */}
              <div className="absolute inset-0 shadow-[inset_0_0_40px_rgba(0,0,0,0.8)] pointer-events-none" />
            </CardContent>
          </Card>

          {/* Audit Log Panel */}
          <Card className="bg-card/40 backdrop-blur-md border-white/5 shadow-xl flex flex-col overflow-hidden">
            <CardHeader className="border-b border-white/5 py-4 px-6 bg-black/20 flex flex-row items-center justify-between">
              <CardTitle className="text-lg font-medium flex items-center gap-2 text-white">
                <Terminal className="h-5 w-5 text-primary" /> Audit Log
              </CardTitle>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleClearLogs}
                disabled={clearLogs.isPending || !logs?.length}
                className="h-8 text-muted-foreground hover:text-white hover:bg-white/10"
              >
                <Trash2 className="h-4 w-4 mr-2" /> Clear
              </Button>
            </CardHeader>
            <CardContent className="p-0 flex-1 relative">
              <ScrollArea className="h-[400px] lg:h-full lg:absolute inset-0">
                <div className="p-4 space-y-2">
                  {!logs?.length ? (
                    <div className="text-center text-muted-foreground py-8 text-sm">
                      No logs available
                    </div>
                  ) : (
                    logs.map((log, index) => (
                      <div 
                        key={log.id} 
                        className="flex items-start gap-3 p-3 rounded-lg bg-black/20 border border-white/5 animate-in fade-in slide-in-from-bottom-2 duration-300"
                        style={{ animationDelay: `${Math.min(index * 50, 500)}ms`, animationFillMode: 'both' }}
                      >
                        <div className="mt-0.5 shrink-0">
                          {getLogIcon(log.level)}
                        </div>
                        <div className="flex-1 space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-semibold uppercase tracking-wider ${getLogColor(log.level)}`}>
                              {log.level}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="text-sm text-white/90 break-words font-mono">
                            {log.message}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
