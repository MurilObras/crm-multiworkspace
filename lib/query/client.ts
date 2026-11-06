import { QueryClient } from '@tanstack/react-query';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        // O cliente HTTP Ã© o dono do retry limitado. Repetir nesta camada
        // multiplicava as tentativas quando a dependÃªncia estava indisponÃ­vel.
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}
