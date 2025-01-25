// Update status every 5 seconds
async function updateStatus() {
  try {
    const response = await fetch('/status');
    const status = await response.json();
    
    document.getElementById('status').innerHTML = `
      <p>Uptime: ${Math.round(status.uptime / 60)} minutes</p>
      <p>Processed Tweets: ${status.processedTweets}</p>
      <p>Next Check: ${new Date(status.nextCheck).toLocaleTimeString()}</p>
      <p>Current Interval: ${status.currentInterval}</p>
    `;
  } catch (error) {
    console.error('Failed to update status:', error);
  }
}

// Set up SSE for live logs
const evtSource = new EventSource('/logs/stream');
const logsDiv = document.getElementById('logs');

evtSource.onmessage = function(event) {
  const log = JSON.parse(event.data);
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${log.type}`;
  
  const timestamp = new Date(log.timestamp).toLocaleTimeString();
  let message = `${timestamp} [${log.type}] ${log.message}`;
  
  if (Object.keys(log).length > 3) { // Has additional data
    message += '\n' + JSON.stringify(log, null, 2);
  }
  
  logEntry.textContent = message;
  logsDiv.insertBefore(logEntry, logsDiv.firstChild);
  
  // Keep only last 100 logs
  while (logsDiv.children.length > 100) {
    logsDiv.removeChild(logsDiv.lastChild);
  }
};

// Update status immediately and every 5 seconds
updateStatus();
setInterval(updateStatus, 5000); 