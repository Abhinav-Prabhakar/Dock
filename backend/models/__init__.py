"""Supervised models fitted on the generated parquet data.

Pure numpy/pandas, closed-form fits — no sklearn/scipy in the venv.
`DemandForecaster` (weekly TEU ridge forecaster) exists to replace the
simulator's oracle access to future demand; `ElasticityModel` and
`WTPModel` prove the pipeline recovers its own generative parameters.
"""

from .demand import BoundDemandForecaster, DemandForecaster
from .elasticity import ElasticityModel
from .wtp import WTPModel

__all__ = [
    "BoundDemandForecaster",
    "DemandForecaster",
    "ElasticityModel",
    "WTPModel",
]
