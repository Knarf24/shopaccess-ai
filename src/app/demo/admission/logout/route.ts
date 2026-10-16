import { handleDemoAdmissionLogout } from "@/server/demo-admission";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** Mock only. PostgreSQL mode answers not found unless admission was turned on, which fails closed earlier. */
export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleDemoAdmissionLogout(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
