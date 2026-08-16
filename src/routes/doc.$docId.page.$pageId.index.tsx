import { createFileRoute } from '@tanstack/react-router';
import { ViewerScreen } from '@/screens/ViewerScreen';

export const Route = createFileRoute('/doc/$docId/page/$pageId/')({
  component: RouteComponent,
});

function RouteComponent() {
  const { docId, pageId } = Route.useParams();
  return <ViewerScreen docId={docId} pageId={pageId} />;
}
