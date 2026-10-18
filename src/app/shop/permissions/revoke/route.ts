import { handlePermissionRevoke } from "@/server/handlers";
import { pgPermissionsUnavailable, withApplication } from "@/server/respond";

/** M2-3: revoke one of this website session's purchase permissions. Mock only; PostgreSQL refuses (503). */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handlePermissionRevoke(request, runtime), postgres: async () => pgPermissionsUnavailable() });
}
