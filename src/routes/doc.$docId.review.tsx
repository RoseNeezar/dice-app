import { createFileRoute } from '@tanstack/react-router';
import { ReviewScreen } from '@/screens/ReviewScreen';

export const Route = createFileRoute('/doc/$docId/review')({
  component: RouteComponent,
});

function RouteComponent() {
  const { docId } = Route.useParams();
  return <ReviewScreen docId={docId} />;
}
