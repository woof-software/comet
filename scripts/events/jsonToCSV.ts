import fs from 'fs/promises';

const network = 'mainnet';
const deployment = 'usdt';

const main = async () => {
  // Read the JSON file
  const inputFilePath = `./scripts/events/reports/liquidation_events_${network}_${deployment}.json`;
  const jsonContent = await fs.readFile(inputFilePath, 'utf-8');
  const events = JSON.parse(jsonContent);

  // Create CSV header
  const csvLines: string[] = [];
  csvLines.push([
    'blockNumber',
    'transactionHash',
    'timestamp',
    'caller',
    'liquidator',
    'gasUsed',
    'borrower',
    'basePaidOut',
    'basePaidOutUsdValue',
    'collateralAbsorbedAssets',
    'collateralAbsorbedAmounts',
    'collateralAbsorbedUsdValues',
    'buyCollateralBuyers',
    'buyCollateralAssets',
    'buyCollateralBaseAmounts',
    'buyCollateralCollateralAmounts'
  ].join(','));

  // Process each event
  for (const event of events) {
    const collateralAssets = event.collateralAbsorbed.map((c: any) => c.asset).join('|');
    const collateralAmounts = event.collateralAbsorbed.map((c: any) => c.collateralAbsorbed).join('|');
    const collateralUsdValues = event.collateralAbsorbed.map((c: any) => c.usdValue).join('|');
    
    const buyBuyers = event.buyCollateral.map((b: any) => b.buyer).join('|');
    const buyAssets = event.buyCollateral.map((b: any) => b.asset).join('|');
    const buyBaseAmounts = event.buyCollateral.map((b: any) => b.baseAmount).join('|');
    const buyCollateralAmounts = event.buyCollateral.map((b: any) => b.collateralAmount).join('|');

    csvLines.push([
      event.blockNumber,
      event.transactionHash,
      event.timestamp,
      event.caller || '',
      event.liquidator || '',
      event.gasUsed,
      event.borrower || '',
      event.basePaidOut,
      event.basePaidOutUsdValue,
      collateralAssets,
      collateralAmounts,
      collateralUsdValues,
      buyBuyers,
      buyAssets,
      buyBaseAmounts,
      buyCollateralAmounts
    ].join(','));
  }

  // Write CSV file
  const outputFilePath = `./scripts/events/reports/liquidation_events_${network}_${deployment}.csv`;
  await fs.writeFile(outputFilePath, csvLines.join('\n'));
  console.log(`CSV file written to ${outputFilePath}`);
  console.log(`Total events: ${events.length}`);
};

main().then().catch(console.error);
