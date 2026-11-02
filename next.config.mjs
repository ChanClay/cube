/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 视频 URL 来自第三方 CDN，前端直接用 <video src> 播放，无需 next/image 白名单
};

export default nextConfig;
