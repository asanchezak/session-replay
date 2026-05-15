import { Link } from "react-router-dom";
import { Home } from "lucide-react";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <h1 className="text-4xl font-bold text-text-primary mb-2">404</h1>
      <p className="text-text-secondary text-sm mb-6">Page not found</p>
      <Link
        to="/dashboard"
        className="flex items-center gap-2 px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
      >
        <Home size={14} /> Go to Dashboard
      </Link>
    </div>
  );
}
