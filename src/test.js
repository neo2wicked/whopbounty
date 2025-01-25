// Test both live and test modes
async function test() {
  console.log('Testing store generation...');
  
  const tweet = {
    id: '123456',
    text: '@GenerateWhop Create a Solana NFT trading community store'
  };

  try {
    // Test mode
    const testResult = await handleWhopGeneration(tweet, true);
    console.log('Test mode completed:', testResult);
    
    // Live mode (uncomment to test)
    // const liveResult = await handleWhopGeneration(tweet, false);
    // console.log('Live mode completed:', liveResult);
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test(); 