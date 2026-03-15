export function VideoPlayer({ jobId }: { jobId: string }) {
  return (
    <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
      <p className="text-[#555555] text-sm">
        Video preview &mdash; job: {jobId}
      </p>
    </div>
  );
}
