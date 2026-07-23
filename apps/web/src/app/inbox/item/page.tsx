import { Suspense } from "react";
import { ItemDetailView } from "./item-detail";

export default function ItemDetailPage() {
  return (
    <Suspense fallback={null}>
      <ItemDetailView />
    </Suspense>
  );
}
