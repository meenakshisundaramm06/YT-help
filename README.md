# YouTube Watch Later Cleanup

A tool to help you triage and clean up your YouTube Watch Later playlist by grouping videos by channel.

## What Does It Do?

If your YouTube Watch Later playlist has hundreds of videos, this tool helps you:
- **Group videos by channel** - See which channels dominate your playlist
- **Bulk delete** - Remove entire channels or selected videos at once
- **Quick review** - Navigate through videos with keyboard shortcuts
- **Visual organization** - Color-coded channels with progress tracking

## Two Ways to Use

### 1. Chrome Extension (Recommended)
A proper browser extension that integrates with YouTube.

### 2. Python Script (macOS only)
A standalone script that controls Chrome via AppleScript.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     USER INTERFACE                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Categories  │→ │  Grid View   │→ │ Detail View  │     │
│  │   (Channels) │  │ (Thumbnails) │  │ (Single Vid) │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────┐
│                    STATE MANAGEMENT                         │
│  • allVideos[]        • selectedIndices                     │
│  • currentCat         • selectedCategories                  │
│  • removedTotal       • view (loading/categories/grid...)   │
└─────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────┐
│                  YOUTUBE INTERACTION                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Scan Playlist│→ │ Group Videos │→ │Remove Videos │     │
│  │  (ytcfg API) │  │ (by channel) │  │  (API calls) │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. SCAN PHASE
   YouTube Watch Later → Fetch all videos → Parse metadata
                                                    ↓
                                          videoId, title, channel,
                                          thumbnail, setVideoId

2. GROUPING PHASE
   All Videos → Count by channel → Filter (MIN_GROUP_SIZE=2)
                                              ↓
                                    Categories with colors

3. INTERACTION PHASE
   User selects → Mark for removal → Batch API calls
                                              ↓
                                    Update state & UI

4. REMOVAL PHASE
   Selected videos → YouTube API → Remove from playlist
                                              ↓
                                    Progress tracking
```

---

## Chrome Extension

### Installation

1. **Build the extension:**
   ```bash
   cd extension
   npm install
   npm run build
   ```

2. **Load in Chrome:**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `extension/dist` folder

3. **Use it:**
   - Go to YouTube (any page)
   - Click the extension icon in your toolbar
   - The panel opens and starts scanning automatically

### How It Works

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  background  │←──────→│   app.html   │←──────→│   YouTube    │
│  .ts (SW)    │  Port  │   app.ts     │  Script │   Page       │
│              │  Msgs  │   (UI)       │  Inject │   (DOM)      │
└──────────────┘         └──────────────┘         └──────────────┘
      ↓                         ↓                         ↓
  Manages tabs           Renders UI              Accesses ytcfg
  Coordinates scan       Handles input           Modifies playlist
  Removes videos         Updates state           Returns data
```

**Key Files:**
- `background.ts` - Service worker that manages YouTube tab and coordinates operations
- `app.ts` - Main UI logic and state management
- `app.html` - UI structure
- `app.css` - Styling with Tailwind CSS
- `types.ts` - TypeScript interfaces for messages and data structures

---

## Python Script (macOS)

### Requirements
- macOS (uses AppleScript)
- Google Chrome
- Python 3

### Setup

1. **Enable JavaScript from Apple Events:**
   - Open Chrome
   - Menu: `View` → `Developer` → `Allow JavaScript from Apple Events`

2. **Open Watch Later:**
   - Go to `https://www.youtube.com/playlist?list=WL`
   - Make sure you're signed in

3. **Run the script:**
   ```bash
   python3 cleanup_watchlater.py
   ```

### How It Works

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Python     │────────→│   Chrome     │────────→│   YouTube    │
│   Script     │AppleEvt │   Browser    │  HTTP   │   Server     │
│              │         │              │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
      ↓                         ↓                         ↓
  HTTP Server            Executes JS             Returns data
  Keyboard input         Renders UI              Playlist API
  State management       DOM manipulation        Video removal
```

**Key Components:**
- HTTP server on `localhost:9876` serves the UI
- AppleScript executes JavaScript in Chrome's active tab
- Keyboard listener captures shortcuts (Q, A, Delete, etc.)
- State synchronization between Python and browser

---

## Features

### Categories View
- **Checkboxes** - Select multiple channels
- **Select all** - Toggle all channels at once
- **Bulk delete** - Remove all videos from selected channels
- **Color coding** - Each channel gets a unique color
- **Video count** - See how many videos per channel

### Grid View
- **Thumbnails** - Visual preview of all videos in a channel
- **Multi-select** - Check multiple videos
- **Bulk actions** - Delete selected videos at once
- **Quick navigation** - Click any video to see details

### Detail View
- **Video preview** - Embedded YouTube player
- **Navigation** - Previous/Next with arrow keys
- **Quick actions** - Remove, Keep, or Preview
- **Progress bar** - See your position in the channel
- **Stats** - Track removed vs kept videos

### Keyboard Shortcuts

**Categories View:**
- `1-9, 0` - Jump to channel by number
- `Q` - Quit

**Grid View:**
- `A` - Toggle select all
- `Delete` - Remove selected videos
- `B` / `Escape` - Back to categories

**Detail View:**
- `←` / `→` - Previous/Next video
- `Delete` / `Backspace` - Remove video
- `Tab` - Keep video and move to next
- `Enter` - Toggle video preview
- `B` / `Escape` - Back to grid
- `R` - Remove all remaining videos
- `Q` - Quit

---

## Configuration

### Minimum Group Size
Videos are grouped by channel only if the channel has at least 2 videos. Channels with fewer videos go into "Other" category.

Change this in the code:
```javascript
const MIN_GROUP_SIZE = 2;  // Change to 1 to see all channels
```

### Colors
13 colors are used in rotation for channel identification. Modify the `COLORS` array to customize.

### Batch Processing
The extension removes videos in batches to avoid rate limiting:
```javascript
const BATCH_SIZE = 20;      // Videos per batch
const BATCH_DELAY = 500;    // ms between batches
```

---

## Development

### Extension Development

```bash
cd extension

# Install dependencies
npm install

# Development mode (auto-rebuild on changes)
npm run dev

# Production build
npm run build
```

### Testing

Use `console-test.js` for rapid testing without rebuilding:
1. Open YouTube in Chrome
2. Open DevTools Console (F12)
3. Copy contents of `extension/console-test.js`
4. Paste into console and press Enter
5. UI appears on the right side of the page

### Project Structure

```
YT-help/
├── extension/
│   ├── src/
│   │   ├── app.ts          # Main UI logic
│   │   ├── app.html        # UI structure
│   │   ├── app.css         # Styles
│   │   ├── background.ts   # Service worker
│   │   └── types.ts        # TypeScript types
│   ├── public/
│   │   ├── manifest.json   # Extension config
│   │   └── icons/          # Extension icons
│   ├── package.json
│   ├── vite.config.ts
│   └── console-test.js     # Standalone test version
└── cleanup_watchlater.py   # Python script version
```

---

## Troubleshooting

### Extension Issues

**"Failed to scan playlist"**
- Make sure you're on youtube.com
- Refresh the YouTube page
- Try reopening the extension

**Videos not removing**
- Check if you're signed in to YouTube
- Some videos may be unavailable or already removed
- Check browser console for errors

**Extension not appearing**
- Verify it's enabled in `chrome://extensions/`
- Check that the build completed successfully
- Try reloading the extension

### Python Script Issues

**"JavaScript from Apple Events" not working**
- Restart Chrome after enabling the setting
- Make sure Chrome is the active window
- Check macOS permissions for Terminal/Python

**Keyboard shortcuts not working**
- Make sure Terminal has focus
- Some shortcuts may conflict with system shortcuts
- Try running with `sudo` if permission issues occur

**UI not loading**
- Check if port 9876 is already in use
- Verify Chrome can access localhost
- Check Python console for error messages

---

## How YouTube API Works

The tool uses YouTube's internal `ytcfg` API (not the public YouTube Data API):

1. **Scanning:** Fetches playlist continuation tokens to load all videos
2. **Removal:** Uses `setVideoId` to identify and remove specific videos
3. **No API key needed:** Works through your browser session

**Note:** This is an unofficial method and may break if YouTube changes their internal API.

---

## Privacy & Safety

- **No data collection** - Everything runs locally in your browser
- **No external servers** - Direct communication with YouTube only
- **Reversible** - Videos are only removed from Watch Later, not deleted from YouTube
- **Open source** - Inspect the code to verify behavior

---

## Contributing

This project is designed to be AI-agent friendly:
- Clear separation of concerns (UI, state, API)
- Type definitions in `types.ts`
- Minimal dependencies
- Inline documentation

To add features:
1. Update types in `types.ts` if needed
2. Modify state management in `app.ts`
3. Update UI rendering functions
4. Test with `console-test.js` first
5. Build and test the extension

---

## License

MIT License - Feel free to use, modify, and distribute.

---

## Credits

Built to solve the problem of overwhelming Watch Later playlists. Inspired by the need for better YouTube playlist management tools.
