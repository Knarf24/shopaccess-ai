import "../guided-presentation.css";
import "../ui-refresh.css";
import { NotFoundContent } from "@/components/NotFoundContent";

/** Rendered inside this layout when a page calls notFound(). Unmatched URLs use global-not-found.tsx. */
export default function NotFound() {
  return <NotFoundContent />;
}
