import { createFileRoute } from '@tanstack/react-router';
import { EditScreen } from '@/screens/EditScreen';

export const Route = createFileRoute('/doc/$docId/page/$pageId/edit')({
  component: RouteComponent,
});

function RouteComponent() {
  const { docId, pageId } = Route.useParams();
  return <EditScreen docId={docId} pageId={pageId} />;
}
