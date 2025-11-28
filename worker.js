import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // filename.mp4
    const pass = url.searchParams.get("pass");
    
    // 🔥 1. ADMIN PANEL (HOME PAGE) 🔥
    // ဖိုင်နာမည်မပါရင် Admin Panel ပြမယ် (Password စစ်မယ်)
    if (!key || key === "") {
        if (pass !== env.ADMIN_PASSWORD) {
            return new Response("Unauthorized Access", { status: 403 });
        }
        return new Response(renderUI(env.ADMIN_PASSWORD), { headers: { "Content-Type": "text/html" } });
    }

    // 🔥 2. API: REMOTE UPLOAD 🔥
    // UI ကနေ Upload လှမ်းတင်တဲ့ API
    if (url.pathname === "/api/upload" && request.method === "POST") {
        if (pass !== env.ADMIN_PASSWORD) return new Response("Unauthorized", { status: 403 });

        try {
            const body = await request.json();
            const { remoteUrl, customName } = body;

            if (!remoteUrl || !customName) return new Response("Missing Data", { status: 400 });

            // S3 Setup
            const S3 = new S3Client({
                region: "auto",
                endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: env.R2_ACCESS_KEY_ID,
                    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
                },
            });

            // Fetch Remote File
            const remoteRes = await fetch(remoteUrl);
            if (!remoteRes.ok) throw new Error("Cannot fetch remote URL");

            // Stream Upload to R2
            const upload = new Upload({
                client: S3,
                params: {
                    Bucket: env.R2_BUCKET_NAME,
                    Key: customName,
                    Body: remoteRes.body,
                    ContentType: remoteRes.headers.get("content-type") || "video/mp4",
                    ContentDisposition: `attachment; filename="${customName}"`, // Auto Download
                    CacheControl: "public, max-age=31536000, immutable"
                },
                queueSize: 4,
                partSize: 20 * 1024 * 1024
            });

            await upload.done();

            const fileLink = `${url.origin}/${customName}`;
            return new Response(JSON.stringify({ success: true, link: fileLink }), { headers: { "Content-Type": "application/json" } });

        } catch (e) {
            return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
        }
    }

    // 🔥 3. DOWNLOAD / STREAM PROXY 🔥
    // ဖိုင်နာမည်ပါရင် R2 ကနေ ဆွဲပေးမယ်
    const S3 = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    try {
      const command = new GetObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
      });

      const object = await S3.send(command);

      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Content-Disposition", `attachment; filename="${key}"`); // Auto Download
      
      if (object.ContentType) headers.set("Content-Type", object.ContentType);
      if (object.ContentLength) headers.set("Content-Length", object.ContentLength.toString());

      return new Response(object.Body, { status: 200, headers });

    } catch (error) {
      return new Response("File Not Found", { status: 404 });
    }
  },
};

// --- UI HTML ---
function renderUI(pass) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:sans-serif;background:#111;color:#eee;display:flex;justify-content:center;padding-top:20px}
  .box{background:#222;padding:20px;border-radius:10px;width:95%;max-width:500px}
  input{width:100%;padding:10px;margin:5px 0 15px;background:#333;border:1px solid #444;color:#fff;box-sizing:border-box;border-radius:5px}
  button{width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:5px;font-weight:bold;cursor:pointer}
  button:disabled{background:#555}
  .res{margin-top:20px;display:none}
  #link{color:#4ade80;background:#000;border:1px solid #22c55e}
</style>
</head>
<body>
<div class="box">
  <h2 style="text-align:center">Worker R2 Uploader</h2>
  <label>Video URL:</label>
  <input type="text" id="url" placeholder="http://...">
  <label>Save As (Name):</label>
  <input type="text" id="name" placeholder="movie.mp4">
  <button onclick="up()" id="btn">Upload to R2</button>
  <div class="res" id="res">
    <p>✅ Uploaded!</p>
    <input type="text" id="link" readonly>
    <button onclick="cpy()" style="background:#22c55e;margin-top:5px">Copy Link</button>
  </div>
</div>
<script>
async function up(){
  const u = document.getElementById('url').value;
  const n = document.getElementById('name').value;
  if(!u||!n) return alert('Data missing');
  
  const btn = document.getElementById('btn');
  btn.disabled=true; btn.innerText="Uploading...";
  
  try {
    const r = await fetch('/api/upload?pass=${pass}', {
      method:'POST', body:JSON.stringify({remoteUrl:u, customName:n})
    });
    const d = await r.json();
    if(d.success){
      document.getElementById('link').value = d.link;
      document.getElementById('res').style.display='block';
      btn.innerText="Upload Success";
    } else {
      alert(d.error); btn.innerText="Try Again"; btn.disabled=false;
    }
  } catch(e){ alert('Error'); btn.disabled=false; }
}
function cpy(){
  document.getElementById('link').select();
  document.execCommand('copy');
  alert('Copied');
}
</script>
</body>
</html>
  `;
}
