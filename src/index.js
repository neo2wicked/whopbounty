// Look at you, trying to be all fancy with your Twitter bot
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const axios = require('axios');

// Initialize with both OAuth 1.0a and OAuth 2.0
const twitterClient = new TwitterApi({
  // OAuth 1.0a credentials for streaming
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
  // OAuth 2.0 credentials
  clientId: process.env.TWITTER_CLIENT_ID,
  clientSecret: process.env.TWITTER_CLIENT_SECRET
});

// New OpenAI client because you can't be bothered to read the docs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Oh lord, here we go - the main bot logic that'll probably break
async function handleWhopGeneration(tweet, testMode = false, twitterClient = null) {
  const prompt = tweet.text.replace('@GenerateWhop', '').trim();
  
  try {
    // Generate store details using GPT-4 because you're too lazy to write proper logic
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{
        role: "system",
        content: "Generate a JSON object for a Whop store with these fields: name (string), description (string), boldClaim (string). Make it relevant to the prompt."
      }, {
        role: "user",
        content: prompt
      }]
    });

    const storeDetails = JSON.parse(completion.choices[0].message.content);
    
    // Generate a logo using DALL-E because why not waste more API credits
    const logoResponse = await openai.images.generate({
      prompt: `Professional minimalist logo for ${storeDetails.name}, business icon`,
      n: 1,
      size: '1024x1024'
    });

    // Add this before the Whop API call
    console.log('Attempting to create Whop store with:', {
      name: storeDetails.name,
      description: storeDetails.description,
      bold_claim: storeDetails.boldClaim,
      logo_url: logoResponse.data[0].url
    });

    // Hit that Whop API like it owes you money
    const whopResponse = await axios.post('https://whop.com/api/onboarding/create-company', {
      name: storeDetails.name,
      description: storeDetails.description,
      bold_claim: storeDetails.boldClaim,
      logo_url: logoResponse.data[0].url,
      type: "community",
      visibility: "public",
      _rsc: "1",
      _method: "POST"
    }, {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
        'Origin': 'https://whop.com',
        'Referer': 'https://whop.com/onboarding',
        'X-Frame-Options': 'SAMEORIGIN',
        'Next-Router-State-Tree': 'true',
        'Next-Router-Prefetch': 'true',
        'RSC': '1',
        'X-Vercel-Cache': 'MISS'
      },
      maxRedirects: 5, // Allow some redirects for live mode
      withCredentials: true,
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Only accept success codes
      }
    });

    // Extract store URL from response or headers
    const storeUrl = whopResponse.headers?.location || 
                    whopResponse.data?.url || 
                    `https://whop.com/${storeDetails.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    // Only try to reply if not in test mode
    if (!testMode) {
      await twitterClient.v2.reply(
        `✨ Created your Whop store! Check it out: ${storeUrl}`,
        tweet.id
      );
    }

    return {
      status: 'success',
      store: {
        name: storeDetails.name,
        url: storeUrl,
        response: whopResponse.data
      },
      tweet: testMode ? null : tweet
    };

  } catch (error) {
    // Better error handling
    console.error('Whop error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      headers: error.response?.headers
    });
    
    if (!testMode) {
      await twitterClient.v2.reply(
        `😅 Oops! Something went wrong creating your store. Please try again later.`,
        tweet.id
      );
    }
    throw error;
  }
}

module.exports = { handleWhopGeneration }; 