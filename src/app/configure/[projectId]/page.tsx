import Link from "next/link";
import { ConfigurePanel } from "@/components/configure/ConfigurePanel";

export default function ConfigurePage({
  params,
}: {
  params: { projectId: string };
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-2">
        Your edit settings
      </h2>
      <p className="text-[#a3a3a3] mb-8">
        Adjust anything. We will re-render your cut.
      </p>
      <ConfigurePanel projectId={params.projectId} />
      <div className="mt-8 flex justify-end">
        <Link
          href="/preview/demo-job-id"
          className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200"
        >
          Re-render with changes
        </Link>
      </div>
    </div>
  );
}
