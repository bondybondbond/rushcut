import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-65px)] px-6 text-center">
      <h1 className="text-4xl font-bold text-[#e5e5e5] mb-4">
        Your clips. Edited.
      </h1>
      <p className="text-[#a3a3a3] text-lg mb-10 max-w-md">
        Upload your footage. Get a cut in minutes.
      </p>
      <Link
        href="/upload"
        className="inline-flex items-center px-6 py-3 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200"
      >
        Get started
      </Link>
    </div>
  );
}
