import { createFileRoute } from '@tanstack/react-router';
import { HomeScreen } from '@/screens/HomeScreen';

export const Route = createFileRoute('/trash')({
  component: () => <HomeScreen route={{ name: 'trash' }} />,
});
