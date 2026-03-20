export function VideoPlayer({ src }: { src: string }) {
  return (
    <video
      src={src}
      controls
      className="w-full aspect-video rounded-lg border border-white/10 bg-[#111111]"
    />
  );
}
