import CanvasPage from '@/pages/CanvasPage';
import ErrorBoundary from '@/components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <CanvasPage />
    </ErrorBoundary>
  );
}
