import { createFileRoute } from '@tanstack/react-router';
import { CameraScreen } from '@/screens/CameraScreen';

export const Route = createFileRoute('/doc/$docId/camera')({
  component: RouteComponent,
});

function RouteComponent() {
  const { docId } = Route.useParams();
  return <CameraScreen docId={docId} />;
}
