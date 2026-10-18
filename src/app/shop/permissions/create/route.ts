import { handlePermissionCreate } from "@/server/handlers";
import { pgPermissionsUnavailable, withApplication } from "@/server/respond";

/** M2-3: create an F07 purchase permission for this website session. Mock only; PostgreSQL refuses (503). */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handlePermissionCreate(request, runtime), postgres: async () => pgPermissionsUnavailable() });
}
