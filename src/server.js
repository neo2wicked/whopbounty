// Because every bot needs a home, even if it's a dumpster fire
require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { handleWhopGeneration } = require('./index');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// User context client for everything
const userClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET
});

// Create a list to store recent logs
const recentLogs = [];
const MAX_LOGS = 100;
const clients = new Set();

// Add rate limit tracking at the top with other constants
const RATE_LIMITS = {
  currentInterval: 15000,  // Start at 15 seconds
  maxInterval: 900000,     // Max 15 minutes
  resetTime: null
};

// Modify the log function to broadcast to clients
function log(type, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    ...data
  };
  
  // Store log
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.pop();
  }

  // Broadcast to all connected clients
  const logString = JSON.stringify(logEntry);
  clients.forEach(client => client.write(`data: ${logString}\n\n`));
  
  // Still log to console for Render logs
  console.log(logString);
}

// Serve static dashboard
app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint for real-time logs
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send all recent logs immediately
  recentLogs.forEach(logEntry => {
    res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });

  // Add client to broadcast list
  clients.add(res);

  // Remove client when connection closes
  req.on('close', () => clients.delete(res));
});

// Keep track of processed tweets
const processedTweets = new Set();

async function checkMentions() {
  try {
    log('info', 'Starting mentions check...');

    // Check if we're still in rate limit cooldown
    if (RATE_LIMITS.resetTime && Date.now() < RATE_LIMITS.resetTime) {
      log('info', 'Waiting for rate limit reset', {
        resetsIn: Math.round((RATE_LIMITS.resetTime - Date.now()) / 1000) + 's'
      });
      return;
    }

    // Test Twitter client with a simpler API call first
    try {
      const testCall = await userClient.v2.me();
      log('debug', 'Twitter client test successful', {
        username: testCall.data.username
      });
    } catch (e) {
      if (e.code === 429) {
        handleRateLimit(e);
        return;
      }
      throw e;
    }

    // Try the search with rate limit handling
    let mentions;
    try {
      mentions = await userClient.v2.search('"@GenerateWhop"', {
        max_results: 10, // Reduced from 25 to help with rate limits
        'tweet.fields': ['referenced_tweets', 'author_id', 'text', 'created_at'],
        expansions: ['referenced_tweets.id', 'author_id']
      });
    } catch (searchError) {
      if (searchError.code === 429) {
        handleRateLimit(searchError);
        return;
      }
      log('error', 'Search failed', {
        error: searchError.message,
        code: searchError.code
      });
      throw searchError;
    }

    // Validate mentions response
    log('debug', 'Search response', {
      hasData: !!mentions?.data,
      dataLength: mentions?.data?.length,
      meta: mentions?.meta,
      errors: mentions?.errors
    });

    if (!mentions?.data?.length) {
      log('info', 'No mentions found');
      return;
    }

    log('info', `Found ${mentions.data.length} mentions`);

    for (const tweet of mentions.data) {
      try {
        if (processedTweets.has(tweet.id)) {
          continue;
        }

        log('process', 'Processing tweet', {
          id: tweet.id,
          text: tweet.text
        });

        const result = await handleWhopGeneration(tweet, false, userClient, log);
        
        if (result?.status === 'success') {
          processedTweets.add(tweet.id);
        }

      } catch (error) {
        log('error', 'Error processing tweet', {
          error: error.message,
          id: tweet.id
        });
      }
    }

  } catch (error) {
    log('error', 'Failed to check mentions', {
      error: error.message
    });
  } finally {
    const nextCheck = RATE_LIMITS.resetTime 
      ? Math.max(RATE_LIMITS.currentInterval, RATE_LIMITS.resetTime - Date.now())
      : RATE_LIMITS.currentInterval;
      
    log('info', `Scheduling next check in ${Math.round(nextCheck/1000)}s`);
    setTimeout(checkMentions, nextCheck);
  }
}

// Add rate limit handling function
function handleRateLimit(error) {
  const resetTime = error.rateLimit?.reset 
    ? error.rateLimit.reset * 1000  // Convert to milliseconds
    : Date.now() + 900000; // Default to 15 minutes if no reset time

  RATE_LIMITS.resetTime = resetTime;
  RATE_LIMITS.currentInterval = Math.min(
    RATE_LIMITS.currentInterval * 2,
    RATE_LIMITS.maxInterval
  );

  log('rate-limit', 'Rate limited', {
    resetsAt: new Date(resetTime).toLocaleTimeString(),
    newInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's'
  });
}

// Start the server and bot
app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  
  try {
    const me = await userClient.v2.me();
    log('info', 'Twitter credentials verified', {
      id: me.data.id,
      username: me.data.username,
      name: me.data.name
    });
    
    // Start checking mentions
    checkMentions();
  } catch (error) {
    console.error('Failed to verify Twitter credentials:', error);
  }
}); 