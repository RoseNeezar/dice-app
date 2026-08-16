import { createFileRoute } from '@tanstack/react-router';
import { HomeScreen } from '@/screens/HomeScreen';

export const Route = createFileRoute('/folder/$folderId')({
  component: RouteComponent,
});

function RouteComponent() {
  const { folderId } = Route.useParams();
  return <HomeScreen route={{ name: 'folder', folderId }} />;
}
