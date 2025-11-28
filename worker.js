import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const PASSWORD = env.ADMIN_PASS || "123";

    // 🔥 S3 Client Setup 🔥
    const S3 = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    // (A) UI PAGE (With Progress Bar)
    if (request.method === "GET" && path === "/") {
      const pass = url.searchParams.get("pass");
      if (pass !== PASSWORD) return new Response("Unauthorized", { status: 403 });
      return new Response(renderUI(pass), { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    // (B) API: UPLOAD (Streaming Response for Progress)
    if (request.method === "POST" && path === "/api/upload") {
      const pass = url.searchParams.get("pass");
      if (pass !== PASSWORD) return new Response("Unauthorized", { status: 403 });

      // Create a ReadableStream to send progress updates to the browser
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Function to send JSON lines
      const send = async (data) => {
        await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
      };

      // Start the upload process in the background
      (async () => {
        try {
          const { remoteUrl, customName } = await request.json();
          if (!remoteUrl || !customName) throw new Error("Missing info");

          const remoteRes = await fetch(remoteUrl);
          if (!remoteRes.ok) throw new Error("Remote URL Error");

          const totalSize = parseInt(remoteRes.headers.get("content-length") || "0");

          // Upload setup
          const upload = new Upload({
            client: S3,
            params: {
              Bucket: env.R2_BUCKET_NAME,
              Key: customName,
              Body: remoteRes.body,
              ContentType: getMimeType(customName),
              CacheControl: "public, max-age=31536000, immutable",
              ContentDisposition: `inline; filename="${customName}"`
            },
            queueSize: 4, 
            partSize: 20 * 1024 * 1024 
          });

          // Monitor Progress
          upload.on("httpUploadProgress", (p) => {
            if (totalSize > 0 && p.loaded) {
              const pct = Math.round((p.loaded / totalSize) * 100);
              send({ progress: pct });
            }
          });

          await upload.done();

          // Finished
          const link = `${env.R2_PUBLIC_DOMAIN}/${encodeURIComponent(customName)}`;
          await send({ success: true, link });

        } catch (e) {
          await send({ error: e.message });
        } finally {
          await writer.close();
        }
      })();

      // Return the stream immediately
      return new Response(readable, { 
        headers: { "content-type": "application/x-ndjson" } 
      });
    }

    // (C) DOWNLOAD / REDIRECT
    if (request.method === "GET" && path.startsWith("/download/")) {
      const filename = decodeURIComponent(path.substring(10));
      try {
        const command = new GetObjectCommand({
            Bucket: env.R2_BUCKET_NAME,
            Key: filename,
            ResponseContentDisposition: `inline; filename="${filename}"`,
            ResponseCacheControl: "public, max-age=31536000"
        });
        const signedUrl = await getSignedUrl(S3, command, { expiresIn: 3600 });
        return Response.redirect(signedUrl, 302);
      } catch (e) {
        return new Response("Error", { status: 404 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- Helpers ---
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = { mp4:'video/mp4', mkv:'video/x-matroska', webm:'video/webm' };
  return types[ext] || 'application/octet-stream';
}

function renderUI(pass) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CF R2 Uploader</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding-top: 40px; margin: 0; }
  .box { background: #1e293b; padding: 25px; border-radius: 12px; width: 90%; max-width: 450px; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); }
  h2 { text-align: center; color: #38bdf8; margin-top: 0; font-weight: 600; }
  label { font-size: 0.85rem; color: #94a3b8; display: block; margin-bottom: 5px; }
  input { width: 100%; padding: 12px; margin-bottom: 15px; background: #0f172a; border: 1px solid #334155; color: #fff; border-radius: 8px; box-sizing: border-box; outline: none; transition: 0.2s; }
  input:focus { border-color: #38bdf8; }
  button { width: 100%; padding: 12px; background: #0ea5e9; color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1rem; transition: 0.2s; }
  button:hover { background: #0284c7; }
  button:disabled { background: #334155; color: #64748b; cursor: not-allowed; }
  
  /* Progress Bar */
  .prog-container { margin-top: 20px; display: none; }
  .prog-header { display: flex; justify-content: space-between; font-size: 0.85rem; color: #38bdf8; margin-bottom: 5px; }
  .prog-track { width: 100%; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; }
  .prog-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #818cf8); transition: width 0.3s ease; }
  
  .res { margin-top: 20px; display: none; background: #0f172a; padding: 15px; border-radius: 8px; border: 1px solid #334155; }
  .link-box { display: flex; gap: 5px; }
  .link-input { background: transparent; border: none; color: #4ade80; font-family: monospace; width: 100%; font-size: 0.9rem; }
  .copy-btn { width: auto; padding: 5px 10px; font-size: 0.8rem; background: #334155; }
</style>
</head>
<body>
<div class="box">
  <h2>☁️ Cloudflare R2 Uploader</h2>
  
  <label>Remote Video URL:</label>
  <input id="url" placeholder="https://example.com/video.mp4">
  
  <label>Save As (Name):</label>
  <input id="name" placeholder="movie.mp4">
  
  <button onclick="up()" id="btn">Start Upload</button>
  
  <!-- Loading Bar -->
  <div class="prog-container" id="progBox">
      <div class="prog-header">
          <span>Uploading...</span>
          <span id="percent">0%</span>
      </div>
      <div class="prog-track">
          <div class="prog-fill" id="fill"></div>
      </div>
  </div>

  <!-- Result -->
  <div class="res" id="res">
    <div style="color:#4ade80; font-size:0.9rem; margin-bottom:5px;">✅ Upload Complete!</div>
    <div class="link-box">
        <input id="link" class="link-input" readonly>
        <button onclick="cpy()" class="copy-btn">Copy</button>
    </div>
  </div>
</div>

<script>
async function up(){
  const u = document.getElementById('url').value;
  const n = document.getElementById('name').value;
  if(!u||!n) return alert('Please fill all fields');
  
  const btn = document.getElementById('btn');
  const progBox = document.getElementById('progBox');
  const fill = document.getElementById('fill');
  const percent = document.getElementById('percent');
  const resBox = document.getElementById('res');

  btn.disabled = true; 
  btn.innerText = "Processing...";
  progBox.style.display = 'block';
  resBox.style.display = 'none';
  fill.style.width = '0%';
  percent.innerText = '0%';

  try {
    const response = await fetch('/api/upload?pass=${pass}', {
      method: 'POST', 
      body: JSON.stringify({ remoteUrl: u, customName: n })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.progress) {
            fill.style.width = msg.progress + '%';
            percent.innerText = msg.progress + '%';
          }
          if (msg.success) {
            progBox.style.display = 'none';
            document.getElementById('link').value = msg.link;
            resBox.style.display = 'block';
            btn.innerText = "Start Upload";
            btn.disabled = false;
          }
          if (msg.error) throw new Error(msg.error);
        } catch (e) { console.error(e); }
      }
    }
  } catch(e) {
    alert("Error: " + e.message);
    btn.disabled = false;
    btn.innerText = "Start Upload";
    progBox.style.display = 'none';
  }
}
function cpy(){
  document.getElementById('link').select();
  document.execCommand('copy');
  alert('Copied!');
}
</script>
</body>
</html>`;
}
