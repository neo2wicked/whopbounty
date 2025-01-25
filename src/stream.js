const { ETwitterStreamEvent } = require('twitter-api-v2');
const { handleWhopGeneration } = require('./index');

async function startStream(client) {
  console.log('Setting up Twitter stream...');
  
  // Filter for mentions because you can't handle all that data
  const stream = await client.v2.searchStream({
    'tweet.fields': ['referenced_tweets', 'author_id'],
    expansions: ['referenced_tweets.id'],
  });

  console.log('Stream connected successfully!');

  stream.autoReconnect = true;

  stream.on(ETwitterStreamEvent.Data, async tweet => {
    console.log('Received tweet:', tweet.text);  // Debug log
    
    // Check if it's a mention and not a reply to avoid infinite loops
    if (tweet.text.startsWith('@GenerateWhop') && !tweet.referenced_tweets) {
      console.log('Processing WhopBot request:', tweet.text);  // Debug log
      try {
        await handleWhopGeneration(tweet);
        console.log('Successfully processed request!');  // Debug log
      } catch (error) {
        console.error("You done messed up:", error);
      }
    } else {
      console.log('Ignoring tweet - not a valid WhopBot request');  // Debug log
    }
  });

  stream.on(ETwitterStreamEvent.ConnectionError, error => {
    console.error('Stream connection error:', error);
  });

  stream.on(ETwitterStreamEvent.ConnectionClosed, () => {
    console.log('Stream connection closed');
  });
}

module.exports = { startStream }; 