import { createFileRoute } from '@tanstack/react-router';
import { DocumentScreen } from '@/screens/DocumentScreen';

export const Route = createFileRoute('/doc/$docId/')({
  component: RouteComponent,
});

function RouteComponent() {
  const { docId } = Route.useParams();
  return <DocumentScreen docId={docId} />;
}
