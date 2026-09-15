// samples.js - Curated real-world test sets for client demonstration
module.exports = [
  {
    id: 'integrity-audit',
    name: 'Scientific Integrity & Retraction Audit',
    description: 'Demonstrates detection of retracted papers, author/year discrepancies, and unresolvable citations.',
    text: `1. Wakefield, A. J., Murch, S. H., Anthony, A., Linnell, J., Casson, D. M., Malik, M., et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. The Lancet, 351(9103), 637-641. https://doi.org/10.1016/s0140-6736(97)11096-0

2. Kucsko, G., Maurer, P. C., Yao, N. Y., Kubo, M., Noh, H. J., Lo, P. K., Park, H., & Lukin, M. D. (2018). Nanometre-scale thermometry in a living cell. Nature, 500(7460), 54-58. https://doi.org/10.1038/nature12373

3. Davis, R. H., & Wilson, E. O. (2020). CRISPR-Cas9 genome editing in human pluripotent stem cells. Cell Stem Cell, 22(3), 320-335. https://doi.org/10.1016/j.stem.2018.02.001

4. Harrison, B. M., & Alvarez, T. (2023). Quantum neural architectures for molecular synthesis prediction. Nature Machine Intelligence, 5(11), 1201-1215. https://doi.org/10.1038/s42256-023-99999-x

5. Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., & Polosukhin, I. Attention is all you need. Advances in Neural Information Processing Systems, 30.`
  },
  {
    id: 'clean-bibliography',
    name: 'Clean Peer-Reviewed Bibliography',
    description: 'Real published papers from Nature, Cell, and Science with valid resolving DOIs.',
    text: `Kucsko, G., Maurer, P. C., Yao, N. Y., Kubo, M., Noh, H. J., Lo, P. K., Park, H., & Lukin, M. D. (2013). Nanometre-scale thermometry in a living cell. Nature, 500(7460), 54-58. https://doi.org/10.1038/nature12373

Jumper, J., Evans, R., Pritzel, A., Green, T., Figurnov, M., Ronneberger, O., ... & Hassabis, D. (2021). Highly accurate protein structure prediction with AlphaFold. Nature, 596(7873), 583-589. https://doi.org/10.1038/s41586-021-03819-2

Doudna, J. A., & Charpentier, E. (2014). The new frontier of genome engineering with CRISPR-Cas9. Science, 346(6213), 1258096. https://doi.org/10.1126/science.1258096`
  },
  {
    id: 'ai-hallucinations',
    name: 'AI-Generated & Hallucinated Citations',
    description: 'Simulates citations produced by LLMs with plausible titles and journals but completely fabricated DOIs.',
    text: `[1] Reynolds, T. K., & Vance, M. P. (2024). Autonomous deep learning frameworks for synthetic biology. Cell Systems, 14(2), 115-128. https://doi.org/10.1016/j.cels.2024.99.12345

[2] Chen, L., & Kowalski, S. (2023). Topological insulators in room-temperature nanoscale lattices. Physical Review Letters, 131(9), 096402. https://doi.org/10.1103/PhysRevLett.131.999999

[3] Kucsko, G., Maurer, P. C., & Yao, N. Y. (2013). Nanometre-scale thermometry in a living cell. Nature, 500(7460), 54-58. https://doi.org/10.1038/nature12373`
  }
];
