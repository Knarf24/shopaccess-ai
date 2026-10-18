import { handleProfileDelete } from "@/server/handlers";
import { pgDeviceProfileUnavailable, withApplication } from "@/server/respond";

/** Removes this website session's optional device profile. PostgreSQL mode refuses and does not connect. */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handleProfileDelete(request, runtime), postgres: async () => pgDeviceProfileUnavailable() });
}
