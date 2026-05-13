import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex items-center justify-center h-screen bg-[#0F1117] text-[#E8EAED]">
          <div className="text-center p-8">
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-[#9AA0B0] mb-4">{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-[#6C5CE7] rounded text-sm">
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
