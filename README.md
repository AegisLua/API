# convert.iidk.online

This project is a Node.js media processing server. It downloads media from URLs, converts formats, and returns processed files through HTTP endpoints.

### What it uses

* Express for the web server
* Axios for downloading files
* yt-dlp for downloading media from supported platforms
* FFmpeg for audio and video conversion
* A proxy system to handle network requests
* A simple rate limiter per IP

### Main features

The server can:

* Convert media from a URL into WAV audio
* Convert images into PNG with scaling
* Download and decode Roblox assets
* Split videos into GIF and WAV output
* Use yt-dlp for supported media sites
* Fall back to direct downloads when needed
* Automatically refresh proxies when failures happen

### Startup process

When the server starts:

1. It checks if yt-dlp needs an update
2. If updated, it restarts itself
3. It loads or finds a working proxy
4. It starts the Express server

### API endpoints

#### GET /wavify

Takes a `url` parameter.
Downloads media and converts audio to WAV format.

#### GET /pngify

Takes:

* `url`
* optional `maxscale`

Downloads an image and resizes it into a PNG.

#### GET /rbxm

Takes a Roblox asset URL or ID.
Downloads and decodes Roblox model or XML data into JSON.

#### GET /gifsplit

Takes a media URL and optional `maxscale`.
Outputs:

* a GIF file
* a WAV file
  Files expire after a short time or after download.

#### GET /gifsplit/file/:token/:type

Serves generated GIF or WAV files from gifsplit.

#### GET /health

Returns server status.

### Security features

* Blocks requests to private and internal IP ranges
* Only allows HTTP and HTTPS URLs
* Uses DNS resolution checks before downloading
* Rate limits requests to 1 per second per IP
* Cleans up temporary files after use

### Proxy system

* Loads proxy from environment variable if available
* If that fails, fetches proxies from ProxyScrape
* Tests proxies and picks the fastest working one
* Automatically retries failed requests with a new proxy

### Media handling

* Uses yt-dlp for supported sites like YouTube, TikTok, Spotify, and others
* Uses FFmpeg to convert audio and video formats
* Supports both streaming downloads and direct file downloads

### Temporary files

* Files are stored in the system temp directory
* Files are deleted after use or after expiration
* gifsplit files expire after 5 minutes

### Summary

This server acts as a media conversion and download API with proxy support, security checks, and temporary file management.